from __future__ import annotations
import json
import logging

log = logging.getLogger(__name__)

try:
    import paho.mqtt.client as mqtt  # type: ignore
except Exception:
    mqtt = None


class MQTTService:
    def __init__(self, cfg: dict):
        self.cfg = cfg or {}
        self.enabled = bool(self.cfg.get("enabled")) and mqtt is not None
        self.client = None
        self.base_topic = self.cfg.get("base_topic", "garden-monitor")
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
            self.client.publish(f"{self.base_topic}/{topic}", body, qos=0, retain=retain)
        except Exception as e:
            log.warning("MQTT publish failed: %s", e)
