# AbletonMCP/init.py
from __future__ import absolute_import, print_function, unicode_literals

from _Framework.ControlSurface import ControlSurface
import errno
import math
import socket
import json
import threading
import time
import traceback
import Live

# Change queue import for Python 2
try:
    import Queue as queue  # Python 2
except ImportError:
    import queue  # Python 3

# Constants for socket communication
DEFAULT_PORT = 9877
HOST = "localhost"

# Non-blocking server pumped by a Live.Base.Timer on the main thread. Socket threads only
# get the GIL when Live's main thread calls into Python (~100 ms apart), so a threaded
# server answers in 300-600 ms; pumping from a timer answers in ~10 ms. Live's timer
# resolution is 10 ms (a 5 ms request still fires at 100 Hz), which is also the ramp rate.
PUMP_INTERVAL_MS = 10
MAX_REQUEST_BYTES = 16 * 1024 * 1024
CLIENT_IDLE_SECONDS = 60
_WOULD_BLOCK = (errno.EAGAIN, errno.EWOULDBLOCK, errno.EINTR)

# Automation / ramp helpers (pure functions, unit-tested without Live)
CURVES = ("linear", "step", "smooth", "ease_in", "ease_out")
MAX_AUTOMATION_STEPS = 20000
_EPS = 1e-9


def _is_number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) \
        and not math.isnan(value) and not math.isinf(value)


def _as_index(value, name):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or int(value) != value:
        raise ValueError("{0} must be an integer".format(name))
    return int(value)


def _ease(curve, x):
    """Map progress x in [0, 1] to eased progress for the named curve."""
    if curve == "linear":
        return x
    if curve == "smooth":
        return x * x * (3.0 - 2.0 * x)
    if curve == "ease_in":
        return x * x
    if curve == "ease_out":
        return 1.0 - (1.0 - x) * (1.0 - x)
    raise ValueError("curve must be one of: " + ", ".join(CURVES))


def _normalize_points(points, clip_length, lo, hi):
    """Validate and time-sort automation points ({time, value[, curve]})."""
    if not isinstance(points, list) or not points:
        raise ValueError("points must be a non-empty list of {time, value} objects")
    cleaned = []
    for i, point in enumerate(points):
        if not isinstance(point, dict):
            raise ValueError("points[{0}] must be an object with time and value".format(i))
        time_beats, value = point.get("time"), point.get("value")
        if not _is_number(time_beats) or not _is_number(value):
            raise ValueError("points[{0}] needs numeric time and value".format(i))
        if time_beats < -_EPS or time_beats > clip_length + _EPS:
            raise ValueError("points[{0}].time {1} is outside the clip (0 to {2} beats)".format(i, time_beats, clip_length))
        if value < lo - _EPS or value > hi + _EPS:
            raise ValueError("points[{0}].value {1} is outside the parameter range {2} to {3}".format(i, value, lo, hi))
        curve = point.get("curve")
        if curve is not None and curve not in CURVES:
            raise ValueError("points[{0}].curve must be one of: {1}".format(i, ", ".join(CURVES)))
        cleaned.append({"time": min(max(float(time_beats), 0.0), float(clip_length)),
                        "value": min(max(float(value), lo), hi), "curve": curve, "order": i})
    cleaned.sort(key=lambda point: (point["time"], point["order"]))
    return cleaned


def _build_steps(points, default_curve, resolution, clip_length, hold):
    """Turn normalized points into [(start, length, value)] envelope steps.

    A ramp segment is a staircase whose first step is exactly its start value and whose last
    step is exactly its end value. With hold, the clip's edges are filled so the whole clip
    is defined."""
    if default_curve not in CURVES:
        raise ValueError("curve must be one of: " + ", ".join(CURVES))
    if not _is_number(resolution) or resolution <= 0:
        raise ValueError("resolution must be a positive number of beats")
    steps = []
    first, last = points[0], points[-1]
    if hold and first["time"] > _EPS:
        steps.append((0.0, first["time"], first["value"]))
    for i in range(len(points) - 1):
        a, b = points[i], points[i + 1]
        segment = b["time"] - a["time"]
        if segment <= _EPS:
            continue
        curve = a["curve"] or default_curve
        if curve == "step":
            steps.append((a["time"], segment, a["value"]))
            continue
        count = max(1, int(math.ceil(segment / resolution - 1e-9)))
        length = segment / count
        for k in range(count):
            # First step is exactly a, last step exactly b (a lone step takes a)
            progress = k / float(count - 1) if count > 1 else 0.0
            steps.append((a["time"] + k * length, length, a["value"] + (b["value"] - a["value"]) * _ease(curve, progress)))
    tail = clip_length - last["time"]
    if tail > _EPS:
        steps.append((last["time"], tail if hold else min(resolution, tail), last["value"]))
    if not steps:
        raise ValueError("nothing to draw: give at least two points at different times, or one point with hold enabled")
    if len(steps) > MAX_AUTOMATION_STEPS:
        raise ValueError("{0} steps exceeds the {1} limit; use a larger resolution".format(len(steps), MAX_AUTOMATION_STEPS))
    return steps

def create_instance(c_instance):
    """Create and return the AbletonMCP script instance"""
    return AbletonMCP(c_instance)

class AbletonMCP(ControlSurface):
    """AbletonMCP Remote Script for Ableton Live"""
    
    def __init__(self, c_instance):
        """Initialize the control surface"""
        ControlSurface.__init__(self, c_instance)
        self.log_message("AbletonMCP Remote Script initializing...")
        
        # Socket server for communication
        self.server = None
        self.client_threads = []
        self.server_thread = None
        self.running = False
        self._clients = {}
        self._pump_timer = None
        self._ramps = {}
        
        # Cache the song reference for easier access
        self._song = self.song()
        
        # Start the socket server
        self.start_server()
        
        self.log_message("AbletonMCP initialized")
        
        # Show a message in Ableton
        self.show_message("AbletonMCP: Listening for commands on port " + str(DEFAULT_PORT))
    
    def disconnect(self):
        """Called when Ableton closes or the control surface is removed"""
        self.log_message("AbletonMCP disconnecting...")
        self._stop_server()
        
        # Clean up any client threads
        for client_thread in self.client_threads[:]:
            if client_thread.is_alive():
                # We don't join them as they might be stuck
                self.log_message("Client thread still alive during disconnect")
        
        ControlSurface.disconnect(self)
        self.log_message("AbletonMCP disconnected")
    
    def _stop_server(self):
        """Stop the pump timer, ramps, open clients and the listening socket."""
        self.running = False
        if self._pump_timer is not None:
            try:
                self._pump_timer.stop()
            except Exception:
                pass
            self._pump_timer = None
        self._ramps = {}
        for client in list(self._clients.keys()):
            self._close_client(client)
        
        # Stop the server
        if self.server:
            try:
                self.server.close()
            except Exception:
                pass
            self.server = None
        
        # Wait for the (fallback) server thread to exit
        if self.server_thread and self.server_thread.is_alive():
            self.server_thread.join(2.0)
        self.server_thread = None
    
    def start_server(self):
        """Start the socket server: pumped by a main-thread timer, or threaded as a fallback"""
        try:
            self.server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            self.server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            self.server.bind((HOST, DEFAULT_PORT))
            self.server.listen(128)
            self._clients = {}
            self.running = True
            
            if hasattr(Live, "Base") and hasattr(Live.Base, "Timer"):
                self.server.setblocking(False)
                self._pump_timer = Live.Base.Timer(callback=self._pump, interval=PUMP_INTERVAL_MS, repeat=True, start=True)
                self.log_message("Server started on port {0} (timer pump, {1} ms)".format(DEFAULT_PORT, PUMP_INTERVAL_MS))
            else:
                self.server_thread = threading.Thread(target=self._server_thread)
                self.server_thread.daemon = True
                self.server_thread.start()
                self.log_message("Server started on port {0} (threaded fallback)".format(DEFAULT_PORT))
        except Exception as e:
            self.log_message("Error starting server: " + str(e))
            self.show_message("AbletonMCP: Error starting server - " + str(e))
    
    # Timer-pumped server (all commands run on Live's main thread)
    
    def _pump(self):
        """Timer callback: accept connections, serve requests, advance ramps.

        Exceptions must never escape: Live.Base.Timer stops itself on a callback error."""
        if not self.running:
            return
        try:
            self._pump_accept()
            self._pump_clients()
        except Exception as e:
            self.log_message("Pump error: " + str(e))
            self.log_message(traceback.format_exc())
        try:
            self._tick_ramps()
        except Exception as e:
            self.log_message("Ramp error: " + str(e))
            self.log_message(traceback.format_exc())
    
    def _pump_accept(self):
        while self.server is not None:
            try:
                client, _address = self.server.accept()
            except socket.error as e:
                if e.errno not in _WOULD_BLOCK:
                    self.log_message("Accept error: " + str(e))
                return
            client.setblocking(False)
            try:
                client.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            except Exception:
                pass
            self._clients[client] = {"in": b"", "out": b"", "last": time.time()}
    
    def _close_client(self, client):
        self._clients.pop(client, None)
        try:
            client.close()
        except Exception:
            pass
    
    def _pump_clients(self):
        now = time.time()
        for client in list(self._clients.keys()):
            state = self._clients.get(client)
            if state is None:
                continue
            peer_closed = False
            while True:
                try:
                    data = client.recv(65536)
                except socket.error as e:
                    if e.errno not in _WOULD_BLOCK:
                        peer_closed = True
                    break
                if not data:
                    peer_closed = True
                    break
                state["in"] += data
                state["last"] = now
                if len(state["in"]) > MAX_REQUEST_BYTES:
                    state["in"] = b""
                    self._queue_response(state, {"status": "error", "message": "Request too large"})
                    break
            
            if state["in"]:
                command = self._parse_request(state["in"])
                if command is not None:
                    state["in"] = b""
                    self._queue_response(state, self._process_command(command, direct=True))
            
            if not self._flush_client(client, state) or (peer_closed and not state["out"]):
                self._close_client(client)
            elif peer_closed or (now - state["last"] > CLIENT_IDLE_SECONDS and not state["out"]):
                self._close_client(client)
    
    def _parse_request(self, raw):
        """Return the decoded command once a full JSON document has arrived, else None."""
        try:
            text = raw.decode("utf-8")
            return json.loads(text)
        except (UnicodeDecodeError, ValueError):
            return None
    
    def _queue_response(self, state, response):
        try:
            payload = json.dumps(response)
        except (TypeError, ValueError) as e:
            payload = json.dumps({"status": "error", "message": "Could not serialize response: " + str(e)})
        state["out"] += payload if isinstance(payload, bytes) else payload.encode("utf-8")
    
    def _flush_client(self, client, state):
        """Send as much pending output as the socket accepts; False if the client is gone."""
        while state["out"]:
            try:
                sent = client.send(state["out"])
            except socket.error as e:
                if e.errno in _WOULD_BLOCK:
                    return True
                return False
            state["out"] = state["out"][sent:]
        return True
    
    def _server_thread(self):
        """Server thread implementation - handles client connections"""
        try:
            self.log_message("Server thread started")
            # Set a timeout to allow regular checking of running flag
            self.server.settimeout(1.0)
            
            while self.running:
                try:
                    # Accept connections with timeout
                    client, address = self.server.accept()
                    self.log_message("Connection accepted from " + str(address))
                    self.show_message("AbletonMCP: Client connected")
                    
                    # Handle client in a separate thread
                    client_thread = threading.Thread(
                        target=self._handle_client,
                        args=(client,)
                    )
                    client_thread.daemon = True
                    client_thread.start()
                    
                    # Keep track of client threads
                    self.client_threads.append(client_thread)
                    
                    # Clean up finished client threads
                    self.client_threads = [t for t in self.client_threads if t.is_alive()]
                    
                except socket.timeout:
                    # No connection yet, just continue
                    continue
                except Exception as e:
                    if self.running:  # Only log if still running
                        self.log_message("Server accept error: " + str(e))
                    time.sleep(0.5)
            
            self.log_message("Server thread stopped")
        except Exception as e:
            self.log_message("Server thread error: " + str(e))
    
    def _handle_client(self, client):
        """Handle communication with a connected client"""
        self.log_message("Client handler started")
        client.settimeout(None)  # No timeout for client socket
        buffer = ''  # Changed from b'' to '' for Python 2
        
        try:
            while self.running:
                try:
                    # Receive data
                    data = client.recv(8192)
                    
                    if not data:
                        # Client disconnected
                        self.log_message("Client disconnected")
                        break
                    
                    # Accumulate data in buffer with explicit encoding/decoding
                    try:
                        # Python 3: data is bytes, decode to string
                        buffer += data.decode('utf-8')
                    except AttributeError:
                        # Python 2: data is already string
                        buffer += data
                    
                    try:
                        # Try to parse command from buffer
                        command = json.loads(buffer)  # Removed decode('utf-8')
                        buffer = ''  # Clear buffer after successful parse
                        
                        self.log_message("Received command: " + str(command.get("type", "unknown")))
                        
                        # Process the command and get response
                        response = self._process_command(command)
                        
                        # Send the response with explicit encoding
                        try:
                            # Python 3: encode string to bytes
                            client.sendall(json.dumps(response).encode('utf-8'))
                        except AttributeError:
                            # Python 2: string is already bytes
                            client.sendall(json.dumps(response))
                    except ValueError:
                        # Incomplete data, wait for more
                        continue
                        
                except Exception as e:
                    self.log_message("Error handling client data: " + str(e))
                    self.log_message(traceback.format_exc())
                    
                    # Send error response if possible
                    error_response = {
                        "status": "error",
                        "message": str(e)
                    }
                    try:
                        # Python 3: encode string to bytes
                        client.sendall(json.dumps(error_response).encode('utf-8'))
                    except AttributeError:
                        # Python 2: string is already bytes
                        client.sendall(json.dumps(error_response))
                    except:
                        # If we can't send the error, the connection is probably dead
                        break
                    
                    # For serious errors, break the loop
                    if not isinstance(e, ValueError):
                        break
        except Exception as e:
            self.log_message("Error in client handler: " + str(e))
        finally:
            try:
                client.close()
            except:
                pass
            self.log_message("Client handler stopped")
    
    def _process_command(self, command, direct=False):
        """Process a command and return a response.

        direct=True means the caller is already on Live's main thread (timer pump), so state-changing
        commands run inline instead of being scheduled and awaited."""
        command_type = command.get("type", "")
        params = command.get("params", {})
        
        # Initialize response
        response = {
            "status": "success",
            "result": {}
        }
        
        try:
            # Route the command to the appropriate handler
            if command_type == "get_session_info":
                response["result"] = self._get_session_info()
            elif command_type == "get_audio_clip_path":
                track_index = params.get("track_index", 0)
                clip_index = params.get("clip_index", 0)
                source = params.get("source", "session")
                response["result"] = self._get_audio_clip_path(track_index, clip_index, source)
            elif command_type == "get_track_info":
                track_index = params.get("track_index", 0)
                response["result"] = self._get_track_info(track_index)
            elif command_type == "get_script_info":
                response["result"] = self._get_script_info()
            elif command_type == "get_clip_notes":
                track_index = params.get("track_index", 0)
                clip_index = params.get("clip_index", 0)
                response["result"] = self._get_clip_notes(track_index, clip_index)
            elif command_type == "get_device_parameters":
                track_index = params.get("track_index", 0)
                device_index = params.get("device_index", 0)
                response["result"] = self._get_device_parameters(track_index, device_index)
            elif command_type == "get_bulk_session_structure":
                response["result"] = self._get_bulk_session_structure()
            # Commands that modify Live's state should be scheduled on the main thread
            elif command_type in ["create_midi_track", "set_track_name", "set_track_color", "set_clip_color",
                                 "create_clip", "add_notes_to_clip", "set_clip_name",
                                 "set_tempo", "fire_clip", "stop_clip", "delete_clip",
                                 "clear_notes_from_clip", "fire_scene", "stop_all_clips",
                                 "set_track_mute", "set_track_solo", "set_track_arm",
                                 "set_scene_name", "eval", "set_scene_tempo", "set_device_parameter",
                                 "start_playback", "stop_playback", "load_browser_item",
                                 "bulk_set_clip_names", "bulk_create_clips", "bulk_set_device_parameters",
                                 "draw_automation", "clear_automation", "ramp_parameter", "cancel_ramps"]:
                # Use a thread-safe approach with a response queue
                response_queue = queue.Queue()
                
                # Define a function to execute on the main thread
                def main_thread_task():
                    try:
                        result = None
                        if command_type == "create_midi_track":
                            index = params.get("index", -1)
                            result = self._create_midi_track(index)
                        elif command_type == "bulk_set_clip_names":
                            items = params.get("items", [])
                            result = self._bulk_set_clip_names(items)
                        elif command_type == "bulk_create_clips":
                            items = params.get("items", [])
                            result = self._bulk_create_clips(items)
                        elif command_type == "bulk_set_device_parameters":
                            items = params.get("items", [])
                            result = self._bulk_set_device_parameters(items)
                        elif command_type == "set_track_name":
                            track_index = params.get("track_index", 0)
                            name = params.get("name", "")
                            result = self._set_track_name(track_index, name)
                        elif command_type == "set_track_color":
                            track_index = params.get("track_index", 0)
                            color = params.get("color", 0)
                            result = self._set_track_color(track_index, color)
                        elif command_type == "set_clip_color":
                            track_index = params.get("track_index", 0)
                            clip_index = params.get("clip_index", 0)
                            color = params.get("color", 0)
                            result = self._set_clip_color(track_index, clip_index, color)
                        elif command_type == "create_clip":
                            track_index = params.get("track_index", 0)
                            clip_index = params.get("clip_index", 0)
                            length = params.get("length", 4.0)
                            result = self._create_clip(track_index, clip_index, length)
                        elif command_type == "add_notes_to_clip":
                            track_index = params.get("track_index", 0)
                            clip_index = params.get("clip_index", 0)
                            notes = params.get("notes", [])
                            result = self._add_notes_to_clip(track_index, clip_index, notes)
                        elif command_type == "set_clip_name":
                            track_index = params.get("track_index", 0)
                            clip_index = params.get("clip_index", 0)
                            name = params.get("name", "")
                            result = self._set_clip_name(track_index, clip_index, name)
                        elif command_type == "set_tempo":
                            tempo = params.get("tempo", 120.0)
                            result = self._set_tempo(tempo)
                        elif command_type == "fire_clip":
                            track_index = params.get("track_index", 0)
                            clip_index = params.get("clip_index", 0)
                            result = self._fire_clip(track_index, clip_index)
                        elif command_type == "stop_clip":
                            track_index = params.get("track_index", 0)
                            clip_index = params.get("clip_index", 0)
                            result = self._stop_clip(track_index, clip_index)
                        elif command_type == "delete_clip":
                            track_index = params.get("track_index", 0)
                            clip_index = params.get("clip_index", 0)
                            result = self._delete_clip(track_index, clip_index)
                        elif command_type == "clear_notes_from_clip":
                            track_index = params.get("track_index", 0)
                            clip_index = params.get("clip_index", 0)
                            result = self._clear_notes_from_clip(track_index, clip_index)
                        elif command_type == "fire_scene":
                            scene_index = params.get("scene_index", 0)
                            result = self._fire_scene(scene_index)
                        elif command_type == "stop_all_clips":
                            result = self._stop_all_clips()
                        elif command_type == "set_track_mute":
                            track_index = params.get("track_index", 0)
                            mute = params.get("mute", False)
                            result = self._set_track_mute(track_index, mute)
                        elif command_type == "set_track_solo":
                            track_index = params.get("track_index", 0)
                            solo = params.get("solo", False)
                            result = self._set_track_solo(track_index, solo)
                        elif command_type == "set_track_arm":
                            track_index = params.get("track_index", 0)
                            arm = params.get("arm", False)
                            result = self._set_track_arm(track_index, arm)
                        elif command_type == "eval":
                            code = params.get("code", "")
                            try:
                                result = eval(code, {"self": self})
                            except Exception as eval_e:
                                result = str(eval_e)
                        elif command_type == "set_scene_name":
                            scene_index = params.get("scene_index", 0)
                            name = params.get("name", "")
                            result = self._set_scene_name(scene_index, name)
                        elif command_type == "set_scene_tempo":
                            scene_index = params.get("scene_index", 0)
                            tempo = params.get("tempo", 120.0)
                            result = self._set_scene_tempo(scene_index, tempo)
                        elif command_type == "set_device_parameter":
                            track_index = params.get("track_index", 0)
                            device_index = params.get("device_index", 0)
                            parameter_index = params.get("parameter_index", 0)
                            value = params.get("value", 0.0)
                            result = self._set_device_parameter(track_index, device_index, parameter_index, value)
                        elif command_type == "start_playback":
                            result = self._start_playback()
                        elif command_type == "stop_playback":
                            result = self._stop_playback()
                        elif command_type == "load_instrument_or_effect":
                            track_index = params.get("track_index", 0)
                            uri = params.get("uri", "")
                            result = self._load_instrument_or_effect(track_index, uri)
                        elif command_type == "load_browser_item":
                            track_index = params.get("track_index", 0)
                            item_uri = params.get("item_uri", "")
                            result = self._load_browser_item(track_index, item_uri)
                        
                        elif command_type == "draw_automation":
                            result = self._draw_automation(params)
                        elif command_type == "clear_automation":
                            result = self._clear_automation(params)
                        elif command_type == "ramp_parameter":
                            result = self._ramp_parameter(params)
                        elif command_type == "cancel_ramps":
                            result = self._cancel_ramps(params)
                        
                        # Put the result in the queue
                        response_queue.put({"status": "success", "result": result})
                    except Exception as e:
                        self.log_message("Error in main thread task: " + str(e))
                        self.log_message(traceback.format_exc())
                        response_queue.put({"status": "error", "message": str(e)})
                
                # Schedule the task to run on the main thread (or run it inline if already there)
                if direct:
                    main_thread_task()
                else:
                    try:
                        self.schedule_message(0, main_thread_task)
                    except AssertionError:
                        # If we're already on the main thread, execute directly
                        main_thread_task()
                
                # Wait for the response with a timeout
                try:
                    task_response = response_queue.get(timeout=10.0)
                    if task_response.get("status") == "error":
                        response["status"] = "error"
                        response["message"] = task_response.get("message", "Unknown error")
                    else:
                        response["result"] = task_response.get("result", {})
                except queue.Empty:
                    response["status"] = "error"
                    response["message"] = "Timeout waiting for operation to complete"
            elif command_type == "get_browser_item":
                uri = params.get("uri", None)
                path = params.get("path", None)
                response["result"] = self._get_browser_item(uri, path)
            elif command_type == "get_browser_categories":
                category_type = params.get("category_type", "all")
                response["result"] = self._get_browser_categories(category_type)
            elif command_type == "get_browser_items":
                path = params.get("path", "")
                item_type = params.get("item_type", "all")
                response["result"] = self._get_browser_items(path, item_type, params.get("limit", 200), params.get("offset", 0))
            # Add the new browser commands
            elif command_type == "get_browser_tree":
                category_type = params.get("category_type", "all")
                response["result"] = self.get_browser_tree(category_type)
            elif command_type == "get_browser_items_at_path":
                path = params.get("path", "")
                response["result"] = self.get_browser_items_at_path(path, params.get("limit", 200), params.get("offset", 0))
            else:
                response["status"] = "error"
                response["message"] = "Unknown command: " + command_type
        except Exception as e:
            self.log_message("Error processing command: " + str(e))
            self.log_message(traceback.format_exc())
            response["status"] = "error"
            response["message"] = str(e)
        
        return response
    
    # Command implementations
    
    def _get_session_info(self):
        """Get information about the current session"""
        try:
            result = {
                "tempo": self._song.tempo,
                "signature_numerator": self._song.signature_numerator,
                "signature_denominator": self._song.signature_denominator,
                "track_count": len(self._song.tracks),
                "return_track_count": len(self._song.return_tracks),
                "master_track": {
                    "name": "Master",
                    "volume": self._song.master_track.mixer_device.volume.value,
                    "panning": self._song.master_track.mixer_device.panning.value
                }
            }
            return result
        except Exception as e:
            self.log_message("Error getting session info: " + str(e))
            raise

    def _get_bulk_session_structure(self):
        """Retrieve full session structure in a single batched call"""
        try:
            tracks_info = []
            for i, track in enumerate(self._song.tracks):
                is_group = getattr(track, 'is_foldable', False)
                is_grouped = getattr(track, 'is_grouped', False)
                group_track_name = None
                if is_grouped and hasattr(track, 'group_track') and track.group_track:
                    group_track_name = track.group_track.name
                
                can_be_armed = False
                if hasattr(track, 'can_be_armed'):
                    try:
                        can_be_armed = track.can_be_armed
                    except Exception:
                        pass
                
                arm = False
                if can_be_armed:
                    try:
                        arm = track.arm
                    except Exception:
                        pass

                playing_slot_index = -1
                clips_summary = []
                if hasattr(track, 'clip_slots'):
                    for slot_index, slot in enumerate(track.clip_slots):
                        if slot.has_clip:
                            c = slot.clip
                            if c.is_playing:
                                playing_slot_index = slot_index
                            clips_summary.append({
                                "slot_index": slot_index,
                                "name": c.name,
                                "is_playing": c.is_playing,
                                "is_recording": c.is_recording
                            })

                tracks_info.append({
                    "index": i,
                    "name": track.name,
                    "is_group": is_group,
                    "is_grouped": is_grouped,
                    "group_track_name": group_track_name,
                    "is_audio_track": getattr(track, 'has_audio_input', False),
                    "is_midi_track": getattr(track, 'has_midi_input', False),
                    "mute": getattr(track, 'mute', False),
                    "solo": getattr(track, 'solo', False),
                    "can_be_armed": can_be_armed,
                    "arm": arm,
                    "volume": track.mixer_device.volume.value if hasattr(track, 'mixer_device') and hasattr(track.mixer_device, 'volume') else 0.0,
                    "panning": track.mixer_device.panning.value if hasattr(track, 'mixer_device') and hasattr(track.mixer_device, 'panning') else 0.0,
                    "playing_slot_index": playing_slot_index,
                    "clips": clips_summary,
                    "device_count": len(track.devices) if hasattr(track, 'devices') else 0
                })

            scenes_info = []
            for idx, scene in enumerate(self._song.scenes):
                scenes_info.append({
                    "index": idx,
                    "name": scene.name
                })

            return {
                "session": self._get_session_info(),
                "scenes": scenes_info,
                "tracks": tracks_info
            }
        except Exception as e:
            self.log_message("Error getting bulk session structure: " + str(e))
            raise

    def _bulk_set_clip_names(self, items):
        """Set multiple clip names in one main thread pass"""
        updated = []
        for item in items:
            t_idx = item.get("track_index")
            c_idx = item.get("clip_index")
            name = item.get("name", "")
            if t_idx is not None and c_idx is not None and 0 <= t_idx < len(self._song.tracks):
                track = self._song.tracks[t_idx]
                if hasattr(track, 'clip_slots') and 0 <= c_idx < len(track.clip_slots):
                    slot = track.clip_slots[c_idx]
                    if slot.has_clip:
                        slot.clip.name = name
                        updated.append({"track_index": t_idx, "clip_index": c_idx, "name": name})
        return {"updated": updated, "count": len(updated)}

    def _bulk_create_clips(self, items):
        """Create multiple clips in one main thread pass"""
        created = []
        for item in items:
            t_idx = item.get("track_index")
            c_idx = item.get("clip_index")
            length = item.get("length", 4.0)
            name = item.get("name", None)
            if t_idx is not None and c_idx is not None and 0 <= t_idx < len(self._song.tracks):
                track = self._song.tracks[t_idx]
                if hasattr(track, 'clip_slots') and 0 <= c_idx < len(track.clip_slots):
                    slot = track.clip_slots[c_idx]
                    if not slot.has_clip:
                        slot.create_clip(length)
                        if name and slot.has_clip:
                            slot.clip.name = name
                        created.append({"track_index": t_idx, "clip_index": c_idx, "length": length, "name": name})
        return {"created": created, "count": len(created)}

    def _bulk_set_device_parameters(self, items):
        """Set multiple device parameters in one main thread pass.

        Reports the value Live actually holds afterwards, and why any item was skipped."""
        updated = []
        skipped = []
        for i, item in enumerate(items):
            try:
                t_idx = item.get("track_index")
                d_idx = item.get("device_index")
                p_idx = item.get("parameter_index")
                val = item.get("value")
                if t_idx is None or d_idx is None or p_idx is None or val is None:
                    raise ValueError("track_index, device_index, parameter_index and value are required")
                if not 0 <= t_idx < len(self._song.tracks):
                    raise IndexError("Track index out of range")
                track = self._song.tracks[t_idx]
                if not 0 <= d_idx < len(track.devices):
                    raise IndexError("Device index out of range")
                device = track.devices[d_idx]
                if not 0 <= p_idx < len(device.parameters):
                    raise IndexError("Parameter index out of range")
                param = device.parameters[p_idx]
                if not param.is_enabled:
                    raise ValueError("Parameter is not enabled")
                param.value = val
                updated.append({"track_index": t_idx, "device_index": d_idx, "parameter_index": p_idx, "value": param.value})
            except Exception as e:
                skipped.append({"item": i, "reason": str(e)})
        return {"updated": updated, "count": len(updated), "skipped": skipped}

    def _get_track_info(self, track_index):
        """Get information about a track"""
        try:
            if track_index < 0 or track_index >= len(self._song.tracks):
                raise IndexError("Track index out of range")
            
            track = self._song.tracks[track_index]
            is_group = getattr(track, 'is_foldable', False)
            is_grouped = getattr(track, 'is_grouped', False)
            group_track_name = None
            if is_grouped and hasattr(track, 'group_track') and track.group_track:
                group_track_name = track.group_track.name

            can_be_armed = False
            if hasattr(track, 'can_be_armed'):
                try:
                    can_be_armed = track.can_be_armed
                except Exception:
                    can_be_armed = False

            arm = False
            if can_be_armed:
                try:
                    arm = track.arm
                except Exception:
                    arm = False

            # Get clip slots
            clip_slots = []
            if hasattr(track, 'clip_slots'):
                for slot_index, slot in enumerate(track.clip_slots):
                    clip_info = None
                    if slot.has_clip:
                        clip = slot.clip
                        clip_info = {
                            "name": clip.name,
                            "length": clip.length,
                            "is_playing": clip.is_playing,
                            "is_recording": clip.is_recording
                        }
                    
                    clip_slots.append({
                        "index": slot_index,
                        "has_clip": slot.has_clip,
                        "clip": clip_info
                    })

            # Get arrangement clips if applicable
            arrangement_clips = []
            if not is_group and hasattr(track, 'arrangement_clips'):
                try:
                    for clip in track.arrangement_clips:
                        arrangement_clips.append({
                            "name": clip.name,
                            "start_time": clip.start_time,
                            "length": clip.length,
                            "muted": getattr(clip, 'muted', False),
                            "is_midi_clip": getattr(clip, 'is_midi_clip', False)
                        })
                except Exception:
                    pass
            
            # Get devices
            devices = []
            if hasattr(track, 'devices'):
                for device_index, device in enumerate(track.devices):
                    devices.append({
                        "index": device_index,
                        "name": device.name,
                        "class_name": device.class_name,
                        "type": self._get_device_type(device)
                    })
            
            result = {
                "index": track_index,
                "name": track.name,
                "is_group": is_group,
                "is_grouped": is_grouped,
                "group_track_name": group_track_name,
                "is_audio_track": getattr(track, 'has_audio_input', False),
                "is_midi_track": getattr(track, 'has_midi_input', False),
                "mute": getattr(track, 'mute', False),
                "solo": getattr(track, 'solo', False),
                "can_be_armed": can_be_armed,
                "arm": arm,
                "volume": track.mixer_device.volume.value if hasattr(track, 'mixer_device') and hasattr(track.mixer_device, 'volume') else 0.0,
                "panning": track.mixer_device.panning.value if hasattr(track, 'mixer_device') and hasattr(track.mixer_device, 'panning') else 0.0,
                "clip_slots": clip_slots,
                "arrangement_clips": arrangement_clips,
                "devices": devices
            }
            return result
        except Exception as e:
            self.log_message("Error getting track info: " + str(e))
            raise

    def _get_script_info(self):
        """Report script version and capabilities (handshake)."""
        capabilities = [
            "get_session_info",
            "get_audio_clip_path",
            "get_track_info",
            "get_bulk_session_structure",
            "get_script_info",
            "create_midi_track",
            "set_track_name", "set_track_color", "set_clip_color",
            "create_clip",
            "add_notes_to_clip",
            "set_clip_name",
            "set_tempo",
            "fire_clip",
            "stop_clip",
            "delete_clip",
            "clear_notes_from_clip",
            "get_clip_notes",
            "fire_scene",
            "stop_all_clips",
            "set_scene_name", "eval",
            "set_track_mute",
            "set_track_solo",
            "set_track_arm",
            "get_device_parameters",
            "set_device_parameter",
            "start_playback",
            "stop_playback",
            "load_browser_item",
            "get_browser_item",
            "get_browser_categories",
            "get_browser_items",
            "get_browser_tree",
            "get_browser_items_at_path",
            "bulk_set_clip_names",
            "bulk_create_clips",
            "bulk_set_device_parameters",
            "draw_automation",
            "clear_automation",
            "ramp_parameter",
            "cancel_ramps"
        ]
        return {
            "script_version": "1.9.0",
            "capabilities": capabilities
        }

    def _get_audio_clip_path(self, track_index, clip_index, source="session"):
        """Return the source path and useful metadata for an audio clip."""
        if source not in ("session", "arrangement"):
            raise ValueError("source must be 'session' or 'arrangement'")
        if track_index < 0 or track_index >= len(self._song.tracks):
            raise IndexError("Track index out of range")

        track = self._song.tracks[track_index]
        clips = track.clip_slots if source == "session" else getattr(track, "arrangement_clips", [])
        if clip_index < 0 or clip_index >= len(clips):
            raise IndexError("Clip index out of range")

        if source == "session":
            slot = clips[clip_index]
            if not slot.has_clip:
                raise ValueError("The selected Session clip slot is empty")
            clip = slot.clip
        else:
            clip = clips[clip_index]

        if not getattr(clip, "is_audio_clip", False):
            raise ValueError("The selected clip is not an audio clip")

        path = getattr(clip, "file_path", "")
        if not path:
            raise ValueError("The selected audio clip has no accessible source file path")

        return {
            "track_index": track_index,
            "track_name": track.name,
            "clip_index": clip_index,
            "clip_source": source,
            "clip_name": clip.name,
            "file_path": path,
            "sample_length": getattr(clip, "sample_length", None),
            "sample_rate": getattr(clip, "sample_rate", None),
            "gain": getattr(clip, "gain", None),
            "pitch_coarse": getattr(clip, "pitch_coarse", None),
            "pitch_fine": getattr(clip, "pitch_fine", None),
            "warping": getattr(clip, "warping", None)
        }

    def _get_clip_notes(self, track_index, clip_index):
        """Read all MIDI notes from a clip"""
        try:
            if track_index < 0 or track_index >= len(self._song.tracks):
                raise IndexError("Track index out of range")

            track = self._song.tracks[track_index]

            if clip_index < 0 or clip_index >= len(track.clip_slots):
                raise IndexError("Clip index out of range")

            clip_slot = track.clip_slots[clip_index]

            if not clip_slot.has_clip:
                raise Exception("No clip in slot")

            clip = clip_slot.clip
            notes = []

            if hasattr(clip, "get_notes_extended"):
                raw_notes = clip.get_notes_extended(0, 128, 0.0, max(1000.0, clip.length))
                for note in raw_notes:
                    notes.append({
                        "pitch": getattr(note, "pitch", 60),
                        "start_time": getattr(note, "start_time", 0.0),
                        "duration": getattr(note, "duration", 0.25),
                        "velocity": getattr(note, "velocity", 100),
                        "mute": getattr(note, "mute", False)
                    })
            else:
                raw_notes = clip.get_notes(0, 0, max(1000.0, clip.length), 128)
                for note in raw_notes:
                    notes.append({
                        "pitch": note[0],
                        "start_time": note[1],
                        "duration": note[2],
                        "velocity": note[3],
                        "mute": note[4]
                    })

            result = {
                "notes": notes,
                "note_count": len(notes)
            }
            return result
        except Exception as e:
            self.log_message("Error getting clip notes: " + str(e))
            raise

    def _get_device_parameters(self, track_index, device_index):
        """Read all parameters for a device on a track"""
        try:
            if track_index < 0 or track_index >= len(self._song.tracks):
                raise IndexError("Track index out of range")

            track = self._song.tracks[track_index]

            if device_index < 0 or device_index >= len(track.devices):
                raise IndexError("Device index out of range")

            device = track.devices[device_index]

            parameters = []
            for param_index, param in enumerate(device.parameters):
                parameters.append({
                    "index": param_index,
                    "name": param.name,
                    "value": param.value,
                    "min": param.min,
                    "max": param.max
                })

            result = {
                "device_name": device.name,
                "parameters": parameters
            }
            return result
        except Exception as e:
            self.log_message("Error getting device parameters: " + str(e))
            raise

    def _create_midi_track(self, index):
        """Create a new MIDI track at the specified index"""
        try:
            # Create the track
            self._song.create_midi_track(index)
            
            # Get the new track
            new_track_index = len(self._song.tracks) - 1 if index == -1 else index
            new_track = self._song.tracks[new_track_index]
            
            result = {
                "index": new_track_index,
                "name": new_track.name
            }
            return result
        except Exception as e:
            self.log_message("Error creating MIDI track: " + str(e))
            raise
    
    
    def _set_track_name(self, track_index, name):
        """Set the name of a track"""
        try:
            if track_index < 0 or track_index >= len(self._song.tracks):
                raise IndexError("Track index out of range")
            
            # Set the name
            track = self._song.tracks[track_index]
            track.name = name
            
            result = {
                "name": track.name
            }
            return result
        except Exception as e:
            self.log_message("Error setting track name: " + str(e))
            raise

    def _set_track_color(self, track_index, color):
        """Set the color of a track (RGB)"""
        try:
            if track_index < 0 or track_index >= len(self._song.tracks):
                raise IndexError("Track index out of range")
            
            track = self._song.tracks[track_index]
            if hasattr(track, 'color'):
                track.color = color
            
            return {
                "color": getattr(track, 'color', None)
            }
        except Exception as e:
            self.log_message("Error setting track color: " + str(e))
            raise
    
    def _create_clip(self, track_index, clip_index, length):
        """Create a new MIDI clip in the specified track and clip slot"""
        try:
            if track_index < 0 or track_index >= len(self._song.tracks):
                raise IndexError("Track index out of range")
            
            track = self._song.tracks[track_index]
            
            if clip_index < 0 or clip_index >= len(track.clip_slots):
                raise IndexError("Clip index out of range")
            
            clip_slot = track.clip_slots[clip_index]
            
            # Check if the clip slot already has a clip
            if clip_slot.has_clip:
                raise Exception("Clip slot already has a clip")
            
            # Create the clip
            clip_slot.create_clip(length)
            
            result = {
                "name": clip_slot.clip.name,
                "length": clip_slot.clip.length
            }
            return result
        except Exception as e:
            self.log_message("Error creating clip: " + str(e))
            raise
    
    def _add_notes_to_clip(self, track_index, clip_index, notes):
        """Add MIDI notes to a clip"""
        try:
            if track_index < 0 or track_index >= len(self._song.tracks):
                raise IndexError("Track index out of range")
            
            track = self._song.tracks[track_index]
            
            if clip_index < 0 or clip_index >= len(track.clip_slots):
                raise IndexError("Clip index out of range")
            
            clip_slot = track.clip_slots[clip_index]
            
            if not clip_slot.has_clip:
                raise Exception("No clip in slot")
            
            clip = clip_slot.clip
            
            if hasattr(clip, "add_new_notes") and hasattr(Live.Clip, "MidiNoteSpecification"):
                specs = []
                for note in notes:
                    spec = Live.Clip.MidiNoteSpecification(
                        pitch=int(note.get("pitch", 60)),
                        start_time=float(note.get("start_time", 0.0)),
                        duration=float(note.get("duration", 0.25)),
                        velocity=float(note.get("velocity", 100)),
                        mute=bool(note.get("mute", False))
                    )
                    specs.append(spec)
                clip.add_new_notes(tuple(specs))
            else:
                live_notes = []
                for note in notes:
                    pitch = note.get("pitch", 60)
                    start_time = note.get("start_time", 0.0)
                    duration = note.get("duration", 0.25)
                    velocity = note.get("velocity", 100)
                    mute = note.get("mute", False)
                    live_notes.append((pitch, start_time, duration, velocity, mute))
                clip.set_notes(tuple(live_notes))
            
            result = {
                "note_count": len(notes)
            }
            return result
        except Exception as e:
            self.log_message("Error adding notes to clip: " + str(e))
            raise
    
    def _set_clip_name(self, track_index, clip_index, name):
        """Set the name of a clip"""
        try:
            if track_index < 0 or track_index >= len(self._song.tracks):
                raise IndexError("Track index out of range")
            
            track = self._song.tracks[track_index]
            
            if clip_index < 0 or clip_index >= len(track.clip_slots):
                raise IndexError("Clip index out of range")
            
            clip_slot = track.clip_slots[clip_index]
            
            if not clip_slot.has_clip:
                raise Exception("No clip in slot")
            
            clip = clip_slot.clip
            clip.name = name
            
            result = {
                "name": clip.name
            }
            return result
        except Exception as e:
            self.log_message("Error setting clip name: " + str(e))
            raise
    
    def _set_tempo(self, tempo):
        """Set the tempo of the session"""
        try:
            self._song.tempo = tempo
            
            result = {
                "tempo": self._song.tempo
            }
            return result
        except Exception as e:
            self.log_message("Error setting tempo: " + str(e))
            raise
    
    def _fire_clip(self, track_index, clip_index):
        """Fire a clip"""
        try:
            if track_index < 0 or track_index >= len(self._song.tracks):
                raise IndexError("Track index out of range")
            
            track = self._song.tracks[track_index]
            
            if clip_index < 0 or clip_index >= len(track.clip_slots):
                raise IndexError("Clip index out of range")
            
            clip_slot = track.clip_slots[clip_index]
            
            if not clip_slot.has_clip:
                raise Exception("No clip in slot")
            
            clip_slot.fire()
            
            result = {
                "fired": True
            }
            return result
        except Exception as e:
            self.log_message("Error firing clip: " + str(e))
            raise
    
    def _stop_clip(self, track_index, clip_index):
        """Stop a clip"""
        try:
            if track_index < 0 or track_index >= len(self._song.tracks):
                raise IndexError("Track index out of range")
            
            track = self._song.tracks[track_index]
            
            if clip_index < 0 or clip_index >= len(track.clip_slots):
                raise IndexError("Clip index out of range")
            
            clip_slot = track.clip_slots[clip_index]
            
            clip_slot.stop()
            
            result = {
                "stopped": True
            }
            return result
        except Exception as e:
            self.log_message("Error stopping clip: " + str(e))
            raise


    def _set_clip_color(self, track_index, clip_index, color):
        """Set the color of a clip"""
        try:
            if track_index < 0 or track_index >= len(self._song.tracks):
                raise IndexError("Track index out of range")
            track = self._song.tracks[track_index]
            if clip_index < 0 or clip_index >= len(track.clip_slots):
                raise IndexError("Clip index out of range")
            
            slot = track.clip_slots[clip_index]
            if slot.has_clip and slot.clip:
                if hasattr(slot.clip, 'color'):
                    slot.clip.color = color
                return {"status": "success", "color": getattr(slot.clip, 'color', color)}
            return {"status": "error", "message": "No clip in slot"}
        except Exception as e:
            self.log_message("Error setting clip color: " + str(e))
            raise

    def _delete_clip(self, track_index, clip_index):
        """Delete the clip in the given clip slot, freeing it for reuse"""
        try:
            if track_index < 0 or track_index >= len(self._song.tracks):
                raise IndexError("Track index out of range")

            track = self._song.tracks[track_index]

            if clip_index < 0 or clip_index >= len(track.clip_slots):
                raise IndexError("Clip index out of range")

            clip_slot = track.clip_slots[clip_index]

            if not clip_slot.has_clip:
                raise Exception("No clip in slot")

            clip_slot.delete_clip()

            result = {
                "deleted": True
            }
            return result
        except Exception as e:
            self.log_message("Error deleting clip: " + str(e))
            raise

    def _clear_notes_from_clip(self, track_index, clip_index):
        """Remove all MIDI notes from a clip"""
        try:
            if track_index < 0 or track_index >= len(self._song.tracks):
                raise IndexError("Track index out of range")

            track = self._song.tracks[track_index]

            if clip_index < 0 or clip_index >= len(track.clip_slots):
                raise IndexError("Clip index out of range")

            clip_slot = track.clip_slots[clip_index]

            if not clip_slot.has_clip:
                raise Exception("No clip in slot")

            clip = clip_slot.clip
            if hasattr(clip, "remove_notes_extended"):
                clip.remove_notes_extended(0, 128, 0.0, max(1000.0, clip.length))
            else:
                clip.remove_notes(0, 0, max(1000.0, clip.length), 128)

            result = {
                "cleared": True
            }
            return result
        except Exception as e:
            self.log_message("Error clearing notes from clip: " + str(e))
            raise

    def _fire_scene(self, scene_index):
        """Fire a scene -- launches every track's clip in that row at once,
        and stops any track that has no clip in that row, exactly like
        clicking the Scene Launch button in Live's Session View."""
        try:
            if scene_index < 0 or scene_index >= len(self._song.scenes):
                raise IndexError("Scene index out of range")

            scene = self._song.scenes[scene_index]
            scene.fire()

            result = {
                "fired": True,
                "name": scene.name
            }
            return result
        except Exception as e:
            self.log_message("Error firing scene: " + str(e))
            raise

    def _stop_all_clips(self):
        """Stop every currently playing session clip across all tracks"""
        try:
            self._song.stop_all_clips()

            result = {
                "stopped": True
            }
            return result
        except Exception as e:
            self.log_message("Error stopping all clips: " + str(e))
            raise


    def _set_scene_tempo(self, scene_index, tempo):
        """Set the tempo of a scene"""
        try:
            if scene_index < 0 or scene_index >= len(self._song.scenes):
                raise IndexError("Scene index out of range")
            scene = self._song.scenes[scene_index]
            if hasattr(scene, 'tempo'):
                scene.tempo = tempo
                return {"name": scene.name, "tempo": scene.tempo}
            else:
                raise Exception("Scene tempo property not found in this Live version")
        except Exception as e:
            self.log_message("Error setting scene tempo: " + str(e))
            return {"status": "error", "message": str(e)}

    def _set_scene_name(self, scene_index, name):
        """Set the name of a scene"""
        try:
            if scene_index < 0 or scene_index >= len(self._song.scenes):
                raise IndexError("Scene index out of range")

            scene = self._song.scenes[scene_index]
            scene.name = name

            result = {
                "name": scene.name
            }
            return result
        except Exception as e:
            self.log_message("Error setting scene name: " + str(e))
            raise

    def _set_track_mute(self, track_index, mute):
        """Mute or unmute a track"""
        try:
            if track_index < 0 or track_index >= len(self._song.tracks):
                raise IndexError("Track index out of range")

            track = self._song.tracks[track_index]
            track.mute = bool(mute)

            result = {
                "mute": track.mute
            }
            return result
        except Exception as e:
            self.log_message("Error setting track mute: " + str(e))
            raise

    def _set_track_solo(self, track_index, solo):
        """Solo or unsolo a track"""
        try:
            if track_index < 0 or track_index >= len(self._song.tracks):
                raise IndexError("Track index out of range")

            track = self._song.tracks[track_index]
            track.solo = bool(solo)

            result = {
                "solo": track.solo
            }
            return result
        except Exception as e:
            self.log_message("Error setting track solo: " + str(e))
            raise

    def _set_track_arm(self, track_index, arm):
        """Arm or disarm a track for recording"""
        try:
            if track_index < 0 or track_index >= len(self._song.tracks):
                raise IndexError("Track index out of range")

            track = self._song.tracks[track_index]

            if not track.can_be_armed:
                raise Exception("Track cannot be armed")

            track.arm = bool(arm)

            result = {
                "arm": track.arm
            }
            return result
        except Exception as e:
            self.log_message("Error setting track arm: " + str(e))
            raise

    def _set_device_parameter(self, track_index, device_index, parameter_index, value):
        """Set a device parameter to a specific value"""
        try:
            if track_index < 0 or track_index >= len(self._song.tracks):
                raise IndexError("Track index out of range")

            track = self._song.tracks[track_index]

            if device_index < 0 or device_index >= len(track.devices):
                raise IndexError("Device index out of range")

            device = track.devices[device_index]

            if parameter_index < 0 or parameter_index >= len(device.parameters):
                raise IndexError("Parameter index out of range")

            parameter = device.parameters[parameter_index]

            if not parameter.is_enabled:
                raise Exception("Parameter is not enabled")

            old_value = parameter.value
            parameter.value = value

            result = {
                "name": parameter.name,
                "old_value": old_value,
                "value": parameter.value
            }
            return result
        except Exception as e:
            self.log_message("Error setting device parameter: " + str(e))
            raise


    # Automation and ramps
    
    def _resolve_parameter(self, params):
        """Locate a device or mixer parameter from track_index plus device_index + parameter_index,
        or mixer_parameter ('volume', 'pan', 'send:N'). Returns (track_index, track, parameter, target)."""
        track_index = _as_index(params.get("track_index"), "track_index")
        if not 0 <= track_index < len(self._song.tracks):
            raise IndexError("Track index out of range")
        track = self._song.tracks[track_index]
        
        mixer_parameter = params.get("mixer_parameter")
        if mixer_parameter is not None:
            if params.get("device_index") is not None or params.get("parameter_index") is not None:
                raise ValueError("give either mixer_parameter or device_index + parameter_index, not both")
            name = str(mixer_parameter).lower()
            mixer = track.mixer_device
            if name == "volume":
                parameter = mixer.volume
            elif name in ("pan", "panning"):
                parameter = mixer.panning
            elif name.startswith("send"):
                digits = name[4:].lstrip(":_ ")
                if not digits.isdigit():
                    raise ValueError("mixer_parameter send must look like 'send:0'")
                if int(digits) >= len(mixer.sends):
                    raise IndexError("Send index out of range")
                parameter = mixer.sends[int(digits)]
            else:
                raise ValueError("mixer_parameter must be 'volume', 'pan' or 'send:N'")
            return track_index, track, parameter, {"mixer_parameter": name}
        
        device_index = _as_index(params.get("device_index"), "device_index")
        parameter_index = _as_index(params.get("parameter_index"), "parameter_index")
        if not 0 <= device_index < len(track.devices):
            raise IndexError("Device index out of range")
        device = track.devices[device_index]
        if not 0 <= parameter_index < len(device.parameters):
            raise IndexError("Parameter index out of range")
        return track_index, track, device.parameters[parameter_index], {"device_index": device_index, "parameter_index": parameter_index}
    
    def _get_session_clip(self, params):
        """Return (track_index, track, clip) for a Session clip slot named by track_index and clip_index."""
        if params.get("source", "session") != "session":
            raise ValueError("Automation envelopes exist only on Session clips (Live's API returns none for arrangement clips)")
        track_index = _as_index(params.get("track_index"), "track_index")
        if not 0 <= track_index < len(self._song.tracks):
            raise IndexError("Track index out of range")
        track = self._song.tracks[track_index]
        clip_index = _as_index(params.get("clip_index"), "clip_index")
        if not 0 <= clip_index < len(track.clip_slots):
            raise IndexError("Clip index out of range")
        slot = track.clip_slots[clip_index]
        if not slot.has_clip:
            raise ValueError("The selected Session clip slot is empty")
        return track_index, track, slot.clip
    
    def _draw_automation(self, params):
        """Draw a clip automation envelope from time/value points (times in beats from clip start)."""
        track_index, track, clip = self._get_session_clip(params)
        _t, _track, parameter, target = self._resolve_parameter(params)
        mode = params.get("mode", "replace")
        if mode not in ("replace", "merge"):
            raise ValueError("mode must be 'replace' or 'merge'")
        hold = params.get("hold", True)
        if not isinstance(hold, bool):
            raise ValueError("hold must be true or false")
        
        clip_length = float(clip.length)
        low, high = float(parameter.min), float(parameter.max)
        points = _normalize_points(params.get("points"), clip_length, low, high)
        steps = _build_steps(points, params.get("curve", "linear"), params.get("resolution", 0.125), clip_length, hold)
        
        if mode == "replace":
            if clip.automation_envelope(parameter) is not None:
                clip.clear_envelope(parameter)
            envelope = clip.create_automation_envelope(parameter)
        else:
            envelope = clip.automation_envelope(parameter)
            if envelope is None:
                envelope = clip.create_automation_envelope(parameter)
            envelope.delete_events_in_range(steps[0][0], steps[-1][0] + steps[-1][1])
        if envelope is None:
            raise RuntimeError("Live did not create an automation envelope for '{0}'".format(parameter.name))
        
        for start, length, value in steps:
            envelope.insert_step(start, length, value)
        
        readback = []
        seen = set()
        for point in points:
            if point["time"] in seen:
                continue
            seen.add(point["time"])
            probe = min(point["time"] + 0.0005, clip_length - 0.0005)
            expected = [value for start, length, value in steps if start - _EPS <= probe < start + length + _EPS]
            readback.append({"time": point["time"], "expected": expected[0] if expected else None,
                             "actual": envelope.value_at_time(probe)})
        
        return {
            "track_index": track_index,
            "clip_name": clip.name,
            "parameter": parameter.name,
            "target": target,
            "range": [low, high],
            "clip_length": clip_length,
            "mode": mode,
            "curve": params.get("curve", "linear"),
            "steps": len(steps),
            "readback": readback
        }
    
    def _clear_automation(self, params):
        """Clear one parameter's envelope on a Session clip, or every envelope if no parameter is given."""
        track_index, track, clip = self._get_session_clip(params)
        wants_parameter = any(params.get(key) is not None for key in ("device_index", "parameter_index", "mixer_parameter"))
        if wants_parameter:
            _t, _track, parameter, target = self._resolve_parameter(params)
            had = clip.automation_envelope(parameter) is not None
            if had:
                clip.clear_envelope(parameter)
            cleared = parameter.name
        else:
            had = bool(clip.has_envelopes)
            clip.clear_all_envelopes()
            cleared = "all"
        return {"track_index": track_index, "clip_name": clip.name, "cleared": cleared,
                "had_envelope": had, "clip_has_envelopes": bool(clip.has_envelopes)}
    
    def _ramp_key(self, track_index, target):
        return "{0}:{1}".format(track_index, sorted(target.items()))
    
    def _ramp_parameter(self, params):
        """Sweep a device or mixer parameter to a target over beats or seconds, driven by the pump timer."""
        track_index, track, parameter, target = self._resolve_parameter(params)
        low, high = float(parameter.min), float(parameter.max)
        end = params.get("to")
        if not _is_number(end) or not low - _EPS <= end <= high + _EPS:
            raise ValueError("to must be a number within the parameter range {0} to {1}".format(low, high))
        start = params.get("from")
        if start is None:
            start = parameter.value
        elif not _is_number(start) or not low - _EPS <= start <= high + _EPS:
            raise ValueError("from must be a number within the parameter range {0} to {1}".format(low, high))
        curve = params.get("curve", "linear")
        if curve not in CURVES or curve == "step":
            raise ValueError("curve must be one of: linear, smooth, ease_in, ease_out")
        beats, seconds = params.get("beats"), params.get("seconds")
        if (beats is None) == (seconds is None):
            raise ValueError("give exactly one of beats or seconds")
        if beats is not None:
            if not _is_number(beats):
                raise ValueError("beats must be a number")
            seconds = beats * 60.0 / float(self._song.tempo)
        if not _is_number(seconds) or not 0.01 <= seconds <= 3600:
            raise ValueError("duration must be between 0.01 and 3600 seconds")
        if not parameter.is_enabled:
            raise ValueError("Parameter is not enabled")
        
        parameter.value = min(max(float(start), low), high)
        self._ramps[self._ramp_key(track_index, target)] = {
            "param": parameter, "start": float(start), "end": float(end), "t0": time.time(),
            "duration": float(seconds), "curve": curve, "low": low, "high": high, "name": parameter.name
        }
        return {"track_index": track_index, "parameter": parameter.name, "target": target, "from": float(start),
                "to": float(end), "seconds": float(seconds), "curve": curve,
                "update_interval_ms": PUMP_INTERVAL_MS, "active_ramps": len(self._ramps)}
    
    def _cancel_ramps(self, params):
        """Cancel one parameter's ramp, or every active ramp when no track_index is given."""
        if params.get("track_index") is None:
            cancelled = len(self._ramps)
            self._ramps = {}
        else:
            track_index, _track, _parameter, target = self._resolve_parameter(params)
            cancelled = 1 if self._ramps.pop(self._ramp_key(track_index, target), None) is not None else 0
        return {"cancelled": cancelled, "active_ramps": len(self._ramps)}
    
    def _tick_ramps(self):
        """Advance every active ramp; called from the pump timer."""
        if not self._ramps:
            return
        now = time.time()
        for key in list(self._ramps.keys()):
            ramp = self._ramps.get(key)
            if ramp is None:
                continue
            progress = (now - ramp["t0"]) / ramp["duration"]
            finished = progress >= 1.0
            if finished:
                value = ramp["end"]
            else:
                value = ramp["start"] + (ramp["end"] - ramp["start"]) * _ease(ramp["curve"], max(progress, 0.0))
            try:
                ramp["param"].value = min(max(value, ramp["low"]), ramp["high"])
            except Exception as e:
                self.log_message("Ramp on '{0}' stopped: {1}".format(ramp["name"], e))
                finished = True
            if finished:
                self._ramps.pop(key, None)
    
    def _start_playback(self):
        """Start playing the session"""
        try:
            self._song.start_playing()
            
            result = {
                "playing": self._song.is_playing
            }
            return result
        except Exception as e:
            self.log_message("Error starting playback: " + str(e))
            raise
    
    def _stop_playback(self):
        """Stop playing the session"""
        try:
            self._song.stop_playing()
            
            result = {
                "playing": self._song.is_playing
            }
            return result
        except Exception as e:
            self.log_message("Error stopping playback: " + str(e))
            raise
    
    def _get_browser_item(self, uri, path):
        """Get a browser item by URI or path"""
        try:
            # Access the application's browser instance instead of creating a new one
            app = self.application()
            if not app:
                raise RuntimeError("Could not access Live application")
                
            result = {
                "uri": uri,
                "path": path,
                "found": False
            }
            
            # Try to find by URI first if provided
            if uri:
                item = self._find_browser_item_by_uri(app.browser, uri)
                if item:
                    result["found"] = True
                    result["item"] = {
                        "name": item.name,
                        "is_folder": item.is_folder,
                        "is_device": item.is_device,
                        "is_loadable": item.is_loadable,
                        "uri": item.uri
                    }
                    return result
            
            # If URI not provided or not found, try by path
            if path:
                # Parse the path and navigate to the specified item
                path_parts = path.split("/")
                
                # Determine the root based on the first part
                current_item = None
                if path_parts[0].lower() == "instruments":
                    current_item = app.browser.instruments
                elif path_parts[0].lower() == "sounds":
                    current_item = app.browser.sounds
                elif path_parts[0].lower() == "drums":
                    current_item = app.browser.drums
                elif path_parts[0].lower() == "audio_effects":
                    current_item = app.browser.audio_effects
                elif path_parts[0].lower() == "midi_effects":
                    current_item = app.browser.midi_effects
                else:
                    # Default to instruments if not specified
                    current_item = app.browser.instruments
                    # Don't skip the first part in this case
                    path_parts = ["instruments"] + path_parts
                
                # Navigate through the path
                for i in range(1, len(path_parts)):
                    part = path_parts[i]
                    if not part:  # Skip empty parts
                        continue
                    
                    found = False
                    for child in current_item.children:
                        if child.name.lower() == part.lower():
                            current_item = child
                            found = True
                            break
                    
                    if not found:
                        result["error"] = "Path part '{0}' not found".format(part)
                        return result
                
                # Found the item
                result["found"] = True
                result["item"] = {
                    "name": current_item.name,
                    "is_folder": current_item.is_folder,
                    "is_device": current_item.is_device,
                    "is_loadable": current_item.is_loadable,
                    "uri": current_item.uri
                }
            
            return result
        except Exception as e:
            self.log_message("Error getting browser item: " + str(e))
            self.log_message(traceback.format_exc())
            raise

    def _get_browser_categories(self, category_type):
        """Legacy alias for get_browser_tree -- same top-level category listing."""
        return self.get_browser_tree(category_type)

    def _get_browser_items(self, path, item_type, limit=200, offset=0):
        """Legacy alias for get_browser_items_at_path, with an item_type filter
        ('all', 'folder', 'device', or 'loadable') applied to the returned items."""
        result = self.get_browser_items_at_path(path, limit, offset)

        if item_type and item_type != "all" and "items" in result:
            key = "is_" + item_type if item_type in ("folder", "device", "loadable") else None
            if key:
                result["items"] = [item for item in result["items"] if item.get(key)]

        return result

    def _load_browser_item(self, track_index, item_uri):
        """Load a browser item onto a track by its URI"""
        try:
            if track_index < 0 or track_index >= len(self._song.tracks):
                raise IndexError("Track index out of range")
            
            track = self._song.tracks[track_index]
            
            # Access the application's browser instance instead of creating a new one
            app = self.application()
            
            # Find the browser item by URI
            item = self._find_browser_item_by_uri(app.browser, item_uri)
            
            if not item:
                raise ValueError("Browser item with URI '{0}' not found".format(item_uri))
            
            # Select the track
            self._song.view.selected_track = track
            
            # Load the item
            app.browser.load_item(item)
            
            result = {
                "loaded": True,
                "item_name": item.name,
                "track_name": track.name,
                "uri": item_uri
            }
            return result
        except Exception as e:
            self.log_message("Error loading browser item: {0}".format(str(e)))
            self.log_message(traceback.format_exc())
            raise
    
    _BROWSER_ROOTS = (
        'instruments', 'sounds', 'drums', 'audio_effects', 'midi_effects', 'samples', 'user_library',
        'current_project', 'clips', 'packs', 'plugins', 'max_for_live', 'user_folders'
    )

    def _browser_roots(self, browser):
        roots = []
        for attr in self._BROWSER_ROOTS:
            try:
                root = getattr(browser, attr, None)
            except Exception:
                root = None
            if root is not None and hasattr(root, 'children'):
                roots.append(root)
        return roots

    def _find_browser_item_by_uri(self, browser_or_item, uri, max_depth=10, current_depth=0):
        """Find a browser item by its URI across every browser root.

        A URI like 'query:Samples#FileId_1' shares its prefix with its root's URI
        ('query:Samples'), so only that root is searched when one matches."""
        try:
            if hasattr(browser_or_item, 'uri') and browser_or_item.uri == uri:
                return browser_or_item
            if current_depth >= max_depth:
                return None

            if hasattr(browser_or_item, 'instruments'):
                roots = self._browser_roots(browser_or_item)
                prefix = uri.split('#', 1)[0]
                matching = [root for root in roots if getattr(root, 'uri', None) == prefix]
                for root in (matching or roots):
                    item = self._find_browser_item_by_uri(root, uri, max_depth, current_depth + 1)
                    if item:
                        return item
                return None

            if hasattr(browser_or_item, 'children') and browser_or_item.children:
                for child in browser_or_item.children:
                    item = self._find_browser_item_by_uri(child, uri, max_depth, current_depth + 1)
                    if item:
                        return item
            return None
        except Exception as e:
            self.log_message("Error finding browser item by URI: {0}".format(str(e)))
            return None
    
    # Helper methods
    
    def _get_device_type(self, device):
        """Get the type of a device"""
        try:
            # Simple heuristic - in a real implementation you'd look at the device class
            if device.can_have_drum_pads:
                return "drum_machine"
            elif device.can_have_chains:
                return "rack"
            elif "instrument" in device.class_display_name.lower():
                return "instrument"
            elif "audio_effect" in device.class_name.lower():
                return "audio_effect"
            elif "midi_effect" in device.class_name.lower():
                return "midi_effect"
            else:
                return "unknown"
        except:
            return "unknown"
    
    def get_browser_tree(self, category_type="all"):
        """
        Get a simplified tree of browser categories.
        
        Args:
            category_type: Type of categories to get ('all', 'instruments', 'sounds', etc.)
            
        Returns:
            Dictionary with the browser tree structure
        """
        try:
            # Access the application's browser instance instead of creating a new one
            app = self.application()
            if not app:
                raise RuntimeError("Could not access Live application")
                
            # Check if browser is available
            if not hasattr(app, 'browser') or app.browser is None:
                raise RuntimeError("Browser is not available in the Live application")
            
            # Log available browser attributes to help diagnose issues
            browser_attrs = [attr for attr in dir(app.browser) if not attr.startswith('_')]
            self.log_message("Available browser attributes: {0}".format(browser_attrs))
            
            root_names = [name for name in self._BROWSER_ROOTS if name in browser_attrs]
            result = {
                "type": category_type,
                "categories": [],
                "available_categories": root_names
            }
            
            # Helper function to process a browser item and its children
            def process_item(item, depth=0):
                if not item:
                    return None
                
                result = {
                    "name": item.name if hasattr(item, 'name') else "Unknown",
                    "is_folder": hasattr(item, 'children') and bool(item.children),
                    "is_device": hasattr(item, 'is_device') and item.is_device,
                    "is_loadable": hasattr(item, 'is_loadable') and item.is_loadable,
                    "uri": item.uri if hasattr(item, 'uri') else None,
                    "children": []
                }
                
                
                return result
            
            # Process based on category type and available attributes
            if (category_type == "all" or category_type == "instruments") and hasattr(app.browser, 'instruments'):
                try:
                    instruments = process_item(app.browser.instruments)
                    if instruments:
                        instruments["name"] = "Instruments"  # Ensure consistent naming
                        result["categories"].append(instruments)
                except Exception as e:
                    self.log_message("Error processing instruments: {0}".format(str(e)))
            
            if (category_type == "all" or category_type == "sounds") and hasattr(app.browser, 'sounds'):
                try:
                    sounds = process_item(app.browser.sounds)
                    if sounds:
                        sounds["name"] = "Sounds"  # Ensure consistent naming
                        result["categories"].append(sounds)
                except Exception as e:
                    self.log_message("Error processing sounds: {0}".format(str(e)))
            
            if (category_type == "all" or category_type == "drums") and hasattr(app.browser, 'drums'):
                try:
                    drums = process_item(app.browser.drums)
                    if drums:
                        drums["name"] = "Drums"  # Ensure consistent naming
                        result["categories"].append(drums)
                except Exception as e:
                    self.log_message("Error processing drums: {0}".format(str(e)))
            
            if (category_type == "all" or category_type == "audio_effects") and hasattr(app.browser, 'audio_effects'):
                try:
                    audio_effects = process_item(app.browser.audio_effects)
                    if audio_effects:
                        audio_effects["name"] = "Audio Effects"  # Ensure consistent naming
                        result["categories"].append(audio_effects)
                except Exception as e:
                    self.log_message("Error processing audio_effects: {0}".format(str(e)))
            
            if (category_type == "all" or category_type == "midi_effects") and hasattr(app.browser, 'midi_effects'):
                try:
                    midi_effects = process_item(app.browser.midi_effects)
                    if midi_effects:
                        midi_effects["name"] = "MIDI Effects"
                        result["categories"].append(midi_effects)
                except Exception as e:
                    self.log_message("Error processing midi_effects: {0}".format(str(e)))
            
            # Try to process other potentially available categories
            for attr in root_names:
                if attr not in ['instruments', 'sounds', 'drums', 'audio_effects', 'midi_effects'] and \
                   (category_type == "all" or category_type == attr):
                    try:
                        item = getattr(app.browser, attr)
                        if hasattr(item, 'children') or hasattr(item, 'name'):
                            category = process_item(item)
                            if category:
                                category["name"] = getattr(item, 'name', None) or attr.capitalize()
                                result["categories"].append(category)
                    except Exception as e:
                        self.log_message("Error processing {0}: {1}".format(attr, str(e)))
            
            self.log_message("Browser tree generated for {0} with {1} root categories".format(
                category_type, len(result['categories'])))
            return result
            
        except Exception as e:
            self.log_message("Error getting browser tree: {0}".format(str(e)))
            self.log_message(traceback.format_exc())
            raise
    
    def get_browser_items_at_path(self, path, limit=200, offset=0):
        """
        Get browser items at a specific path.
        
        Args:
            path: Path in the format "category/folder/subfolder"
                 where category is one of: instruments, sounds, drums, audio_effects, midi_effects
                 or any other available browser category
                 
        Returns:
            Dictionary with items at the specified path
        """
        try:
            # Access the application's browser instance instead of creating a new one
            app = self.application()
            if not app:
                raise RuntimeError("Could not access Live application")
                
            # Check if browser is available
            if not hasattr(app, 'browser') or app.browser is None:
                raise RuntimeError("Browser is not available in the Live application")
            
            # Log available browser attributes to help diagnose issues
            browser_attrs = [attr for attr in dir(app.browser) if not attr.startswith('_')]
            self.log_message("Available browser attributes: {0}".format(browser_attrs))
                
            # Parse the path
            path_parts = path.split("/")
            if not path_parts:
                raise ValueError("Invalid path")
            
            # Determine the root category
            root_category = path_parts[0].lower()
            current_item = None
            
            # Check standard categories first
            if root_category == "instruments" and hasattr(app.browser, 'instruments'):
                current_item = app.browser.instruments
            elif root_category == "sounds" and hasattr(app.browser, 'sounds'):
                current_item = app.browser.sounds
            elif root_category == "drums" and hasattr(app.browser, 'drums'):
                current_item = app.browser.drums
            elif root_category == "audio_effects" and hasattr(app.browser, 'audio_effects'):
                current_item = app.browser.audio_effects
            elif root_category == "midi_effects" and hasattr(app.browser, 'midi_effects'):
                current_item = app.browser.midi_effects
            else:
                # Try to find the category in other browser attributes
                found = False
                for attr in browser_attrs:
                    if attr.lower() == root_category:
                        try:
                            current_item = getattr(app.browser, attr)
                            found = True
                            break
                        except Exception as e:
                            self.log_message("Error accessing browser attribute {0}: {1}".format(attr, str(e)))
                
                if not found:
                    # If we still haven't found the category, return available categories
                    return {
                        "path": path,
                        "error": "Unknown or unavailable category: {0}".format(root_category),
                        "available_categories": [name for name in self._BROWSER_ROOTS if name in browser_attrs],
                        "items": []
                    }
            
            # Navigate through the path
            for i in range(1, len(path_parts)):
                part = path_parts[i]
                if not part:  # Skip empty parts
                    continue
                
                if not hasattr(current_item, 'children'):
                    return {
                        "path": path,
                        "error": "Item at '{0}' has no children".format('/'.join(path_parts[:i])),
                        "items": []
                    }
                
                found = False
                for child in current_item.children:
                    if hasattr(child, 'name') and child.name.lower() == part.lower():
                        current_item = child
                        found = True
                        break
                
                if not found:
                    return {
                        "path": path,
                        "error": "Path part '{0}' not found".format(part),
                        "items": []
                    }
            
            # Get items at the current path
            items = []
            total = 0
            if hasattr(current_item, 'children'):
                children = list(current_item.children)
                total = len(children)
                limit = max(0, int(limit))
                offset = max(0, int(offset))
                for child in children[offset:offset + limit]:
                    item_info = {
                        "name": child.name if hasattr(child, 'name') else "Unknown",
                        "is_folder": bool(getattr(child, 'is_folder', False)),
                        "is_device": hasattr(child, 'is_device') and child.is_device,
                        "is_loadable": hasattr(child, 'is_loadable') and child.is_loadable,
                        "uri": child.uri if hasattr(child, 'uri') else None
                    }
                    items.append(item_info)
            
            result = {
                "path": path,
                "name": current_item.name if hasattr(current_item, 'name') else "Unknown",
                "uri": current_item.uri if hasattr(current_item, 'uri') else None,
                "is_folder": hasattr(current_item, 'children') and bool(current_item.children),
                "is_device": hasattr(current_item, 'is_device') and current_item.is_device,
                "is_loadable": hasattr(current_item, 'is_loadable') and current_item.is_loadable,
                "total": total,
                "offset": offset,
                "truncated": offset + len(items) < total,
                "items": items
            }
            
            self.log_message("Retrieved {0} items at path: {1}".format(len(items), path))
            return result
            
        except Exception as e:
            self.log_message("Error getting browser items at path: {0}".format(str(e)))
            self.log_message(traceback.format_exc())
            raise
