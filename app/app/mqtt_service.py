from __future__ import annotations

import json
import logging
import time

log = logging.getLogger(__name__)

try:
    import paho.mqtt.client as mqtt  # type: ignore
except Exception:
    mqtt = None

# Per-(topic, rc) cool-down for the publish-failure warning. A flapping
# broker can otherwise spam the log on every publish — once every 5 min
# is enough for the operator to notice without drowning the tail.
_PUBLISH_WARN_INTERVAL_S = 300.0


class MQTTService:
    def __init__(self, cfg: dict):
        self.cfg = cfg or {}
        self.enabled = bool(self.cfg.get("enabled")) and mqtt is not None
        self.client = None
        self.base_topic = self.cfg.get("base_topic", "garden-monitor")
        # (topic, rc) → last-warned monotonic timestamp. Bounded growth
        # is fine: the (topic, rc) cardinality is small (~handful of
        # topics × handful of rc codes).
        self._publish_warn_ts: dict[tuple[str, int], float] = {}
        if not self.enabled:
            return
        try:
            self.client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
        except Exception:
            self.client = mqtt.Client()
        if self.cfg.get("username"):
            self.client.username_pw_set(self.cfg.get("username"), self.cfg.get("password"))
        self.client.connect_async(self.cfg.get("host", "mqtt"), int(self.cfg.get("port", 1883)), 30)
        self.client.loop_start()

    def publish(self, topic: str, payload: dict | str, retain: bool = False):
        if not self.enabled or not self.client:
            return
        body = payload if isinstance(payload, str) else json.dumps(payload, ensure_ascii=False)
        try:
            info = self.client.publish(
                f"{self.base_topic}/{topic}", body, qos=0, retain=retain,
            )
            rc = getattr(info, "rc", mqtt.MQTT_ERR_SUCCESS)
            if rc != mqtt.MQTT_ERR_SUCCESS:
                key = (topic, int(rc))
                now = time.monotonic()
                last = self._publish_warn_ts.get(key, 0.0)
                if now - last >= _PUBLISH_WARN_INTERVAL_S:
                    self._publish_warn_ts[key] = now
                    log.warning(
                        "MQTT publish %s failed: rc=%d (%s)",
                        topic, rc, mqtt.error_string(rc),
                    )
        except Exception as e:
            log.warning("MQTT publish failed: %s", e)
