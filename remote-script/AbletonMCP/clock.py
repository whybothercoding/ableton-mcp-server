"""The bridge's clock. Modules call clock.now() so tests can substitute a fake."""
import time

now = time.time
