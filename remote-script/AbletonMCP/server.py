"""Timer-pumped socket server: accepts connections, parses requests and dispatches commands on Live's main thread."""

import errno
import json
import socket
import traceback
import Live
from . import config
from . import clock
from .registry import _COMMANDS
from .registry import command
from .registry import _error_code
from .registry import _error_response
from .registry import GATE_REASONS
from .registry import gate_marker
from .registry import gate_open


_WOULD_BLOCK = (errno.EAGAIN, errno.EWOULDBLOCK, errno.EINTR)


class ServerMixin(object):
    """Timer-pumped socket server: accepts connections, parses requests and dispatches commands on Live's main thread."""

    def disconnect(self):
        """Called when Ableton closes or the control surface is removed"""
        self.log_message("AbletonMCP disconnecting...")
        self._stop_server()
        
        super(ServerMixin, self).disconnect()
        self.log_message("AbletonMCP disconnected")

    def _stop_server(self):
        """Stop the pump timer, ramps, follow actions, open clients and the listening socket."""
        self.running = False
        self._follow = {}
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

    def start_server(self):
        """Start the socket server, pumped by a Live.Base.Timer so every command runs on Live's main thread."""
        try:
            if not (hasattr(Live, "Base") and hasattr(Live.Base, "Timer")):
                raise RuntimeError("Live.Base.Timer is unavailable: AbletonMCP requires Live 12 or later")
            self.server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            self.server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            self.server.bind((config.HOST, config.DEFAULT_PORT))
            self.server.listen(128)
            self.server.setblocking(False)
            self._clients = {}
            self.running = True
            self._pump_timer = Live.Base.Timer(callback=self._pump, interval=config.PUMP_INTERVAL_MS, repeat=True, start=True)
            self.log_message("Server started on port {0} (timer pump, {1} ms)".format(config.DEFAULT_PORT, config.PUMP_INTERVAL_MS))
        except Exception as e:
            self.log_message("Error starting server: " + str(e))
            self.show_message("AbletonMCP: Error starting server - " + str(e))

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
        try:
            self._tick_follow_actions()
        except Exception as e:
            self.log_message("Follow action error: " + str(e))
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
            self._clients[client] = {"in": b"", "out": b"", "last": clock.now()}

    def _close_client(self, client):
        self._clients.pop(client, None)
        try:
            client.close()
        except Exception:
            pass

    def _pump_clients(self):
        now = clock.now()
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
                if len(state["in"]) > config.MAX_REQUEST_BYTES:
                    state["in"] = b""
                    self._queue_response(state, {"status": "error", "message": "Request too large"})
                    break
            
            if state["in"]:
                command = self._parse_request(state["in"])
                if command is not None:
                    state["in"] = b""
                    self._queue_response(state, self._process_command(command))
            
            if not self._flush_client(client, state) or (peer_closed and not state["out"]):
                self._close_client(client)
            elif peer_closed or (now - state["last"] > config.CLIENT_IDLE_SECONDS and not state["out"]):
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

    def _process_command(self, command):
        """Run one bridge command on Live's main thread and return the response dict."""
        started = clock.now()
        if not isinstance(command, dict):
            response = _error_response("INVALID_REQUEST", "Request must be a JSON object")
        else:
            command_type = command.get("type", "")
            params = command.get("params")
            if params is None:
                params = {}
            entry = _COMMANDS.get(command_type)
            if entry is None:
                response = _error_response("UNKNOWN_COMMAND", "Unknown command: " + str(command_type))
            elif not isinstance(params, dict):
                response = _error_response("INVALID_REQUEST", "params must be an object")
            elif entry.get("gate") and not gate_open(entry["gate"]):
                response = _error_response(
                    "UNAVAILABLE",
                    "'{0}' is switched off inside Live because it {1}, and any program on this computer can reach this socket. "
                    "To allow it, create the empty file {2} and try again (delete the file to switch it off again).".format(
                        command_type, GATE_REASONS.get(entry["gate"], "is restricted"), gate_marker(entry["gate"])))
            else:
                try:
                    response = {"status": "success", "result": self._run_command(entry, params)}
                except Exception as e:
                    self.log_message("Error processing command '{0}': {1}".format(command_type, e))
                    self.log_message(traceback.format_exc())
                    response = _error_response(_error_code(e), str(e), getattr(e, "details", None))
        response["elapsed_ms"] = round((clock.now() - started) * 1000.0, 2)
        return response

    def _run_command(self, entry, params):
        if not entry["writes"]:
            return entry["fn"](self, params)
        self._song.begin_undo_step()
        try:
            return entry["fn"](self, params)
        finally:
            self._song.end_undo_step()
