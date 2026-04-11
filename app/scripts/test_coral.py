#!/usr/bin/env python3
"""
TAM-spy Coral TPU Test-Script
==============================
Prüft ob Google Coral USB erkannt wird, lädt das konfigurierte Modell
und schickt ein Test-Bild durch die Inferenz-Pipeline.

Ausführung:
  # Im Container:
  docker exec -it tam-spy python /app/scripts/test_coral.py

  # Lokal (aus app/ Verzeichnis):
  python scripts/test_coral.py

  # Mit benutzerdefiniertem Modell:
  python scripts/test_coral.py --model /app/models/mymodel_edgetpu.tflite \
                                --labels /app/config/coco_labels.example.txt
"""

from __future__ import annotations
import argparse
import sys
import os
import time
import numpy as np

# ── Farben für Terminal-Ausgabe ─────────────────────────────────────────────
GREEN  = "\033[92m"
YELLOW = "\033[93m"
RED    = "\033[91m"
CYAN   = "\033[96m"
RESET  = "\033[0m"
BOLD   = "\033[1m"

def ok(msg):   print(f"{GREEN}  ✅ {msg}{RESET}")
def warn(msg): print(f"{YELLOW}  ⚠️  {msg}{RESET}")
def err(msg):  print(f"{RED}  ❌ {msg}{RESET}")
def info(msg): print(f"{CYAN}  ℹ️  {msg}{RESET}")
def head(msg): print(f"\n{BOLD}{msg}{RESET}")


# ── Standard-Pfade aus config.yaml ─────────────────────────────────────────
DEFAULT_MODEL  = "/app/models/coco_ssd_mobilenet_v2_coco_quant_postprocess_edgetpu.tflite"
DEFAULT_LABELS = "/app/config/coco_labels.example.txt"


def load_labels(path: str) -> dict[int, str]:
    if not os.path.exists(path):
        return {}
    labels = {}
    for line in open(path, encoding="utf-8"):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if ":" in line:
            k, v = line.split(":", 1)
        elif " " in line:
            k, v = line.split(" ", 1)
        else:
            continue
        try:
            labels[int(k.strip())] = v.strip()
        except ValueError:
            pass
    return labels


def create_test_image(width=300, height=300) -> np.ndarray:
    """Erstellt ein synthetisches Testbild (bunte Rechtecke)."""
    img = np.zeros((height, width, 3), dtype=np.uint8)
    img[50:150, 50:150] = [0, 120, 255]    # blaues Rechteck (Himmel)
    img[150:250, 100:200] = [0, 200, 80]   # grünes Rechteck (Gras)
    img[80:120, 200:280] = [180, 100, 50]  # bräunliches Rechteck (Vogel-Platzhalter)
    return img


def check_usb_coral():
    """Prüft ob ein Coral USB Stick im System sichtbar ist."""
    head("SCHRITT 1 – USB Coral Gerät")
    # Vendor ID für Google Coral Edge TPU: 18d1 (Google), 1a6e (Global Unichip)
    coral_vendor_ids = {"18d1", "1a6e"}
    found = False

    # Methode 1: /sys/bus/usb/devices
    usb_base = "/sys/bus/usb/devices"
    if os.path.isdir(usb_base):
        for dev in os.listdir(usb_base):
            id_vendor_path = os.path.join(usb_base, dev, "idVendor")
            id_product_path = os.path.join(usb_base, dev, "idProduct")
            try:
                vendor = open(id_vendor_path).read().strip()
                product = open(id_product_path).read().strip()
                if vendor in coral_vendor_ids:
                    ok(f"Coral USB gefunden: vendor={vendor} product={product} (dev={dev})")
                    found = True
            except Exception:
                pass

    # Methode 2: /dev/bus/usb existiert
    if os.path.isdir("/dev/bus/usb"):
        ok("/dev/bus/usb ist verfügbar (USB Passthrough aktiv)")
    else:
        warn("/dev/bus/usb nicht gefunden – kein USB Passthrough?")

    if not found:
        warn("Kein Coral USB Gerät über /sys/bus erkannt. Prüfe: lsusb | grep -i coral")
        info("Coral Vendor IDs: 18d1 (Google/Coral), 1a6e (Global Unichip Corp)")

    return found


def check_libedgetpu():
    """Prüft ob libedgetpu installiert ist."""
    head("SCHRITT 2 – libedgetpu Bibliothek")
    lib_paths = [
        "/usr/lib/x86_64-linux-gnu/libedgetpu.so.1",
        "/usr/lib/aarch64-linux-gnu/libedgetpu.so.1",
        "/usr/lib/arm-linux-gnueabihf/libedgetpu.so.1",
        "/usr/local/lib/libedgetpu.so.1",
    ]
    found_lib = None
    for p in lib_paths:
        if os.path.exists(p):
            found_lib = p
            break
    if found_lib:
        ok(f"libedgetpu gefunden: {found_lib}")
    else:
        warn("libedgetpu.so.1 nicht in Standard-Pfaden gefunden")
        info("Installiert via: apt-get install libedgetpu1-std")
    return found_lib is not None


def check_pycoral():
    """Prüft ob pycoral importierbar ist."""
    head("SCHRITT 3 – pycoral Python-Paket")
    try:
        from pycoral.utils.edgetpu import make_interpreter  # type: ignore
        from pycoral.adapters import common, detect          # type: ignore
        ok("pycoral erfolgreich importiert")
        return True, make_interpreter, common, detect
    except ImportError as e:
        warn(f"pycoral nicht verfügbar: {e}")
        info("Installiert via: pip install --extra-index-url https://google-coral.github.io/py-repo pycoral~=2.0")
        return False, None, None, None


def check_tflite_runtime():
    """Prüft ob tflite-runtime als CPU-Fallback verfügbar ist."""
    head("SCHRITT 4 – tflite-runtime (CPU-Fallback)")
    try:
        import tflite_runtime.interpreter as tflite  # type: ignore
        ok("tflite-runtime erfolgreich importiert (CPU-Fallback verfügbar)")
        return True, tflite
    except ImportError as e:
        warn(f"tflite-runtime nicht verfügbar: {e}")
        info("Installiert via: pip install tflite-runtime")
        return False, None


def run_inference_coral(model_path: str, labels: dict, make_interpreter, common, detect):
    """Führt Inferenz mit pycoral durch."""
    head("SCHRITT 5a – Coral TPU Inferenz")

    if not os.path.exists(model_path):
        err(f"Modell nicht gefunden: {model_path}")
        print_model_download_instructions(model_path)
        return False

    try:
        info(f"Lade Modell: {model_path}")
        t0 = time.perf_counter()
        interpreter = make_interpreter(model_path)
        interpreter.allocate_tensors()
        load_ms = (time.perf_counter() - t0) * 1000
        ok(f"Modell geladen in {load_ms:.0f} ms")

        width, height = common.input_size(interpreter)
        info(f"Eingabegröße: {width}x{height}")

        img = create_test_image(width, height)
        import cv2
        rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
        resized = cv2.resize(rgb, (width, height))

        common.set_input(interpreter, resized)

        t1 = time.perf_counter()
        interpreter.invoke()
        infer_ms = (time.perf_counter() - t1) * 1000

        ok(f"Inferenz abgeschlossen in {infer_ms:.1f} ms")

        objs = detect.get_objects(interpreter, score_threshold=0.1)
        if objs:
            ok(f"{len(objs)} Objekt(e) erkannt:")
            for o in objs[:5]:
                label = labels.get(int(o.id), str(o.id))
                print(f"    • {label} ({o.score:.2%})")
        else:
            info("Keine Objekte über Score 0.1 erkannt (synthetisches Bild – normal)")

        print(f"\n{GREEN}{BOLD}  🎉 CORAL TPU FUNKTIONIERT! Inferenz in {infer_ms:.1f} ms{RESET}")
        return True

    except Exception as e:
        err(f"Coral Inferenz fehlgeschlagen: {e}")
        return False


def run_inference_cpu(model_path: str, labels: dict, tflite):
    """Führt Inferenz mit tflite-runtime auf CPU durch."""
    head("SCHRITT 5b – CPU Fallback Inferenz (tflite-runtime)")

    # Für EdgeTPU-Modelle → CPU-Variante ohne _edgetpu
    cpu_model = model_path.replace("_edgetpu.tflite", ".tflite")
    if not os.path.exists(cpu_model):
        cpu_model = model_path  # Fallback auf Original

    if not os.path.exists(cpu_model):
        err(f"Modell nicht gefunden: {cpu_model}")
        print_model_download_instructions(cpu_model)
        return False

    try:
        info(f"Lade CPU-Modell: {cpu_model}")
        t0 = time.perf_counter()
        interpreter = tflite.Interpreter(model_path=cpu_model)
        interpreter.allocate_tensors()
        load_ms = (time.perf_counter() - t0) * 1000
        ok(f"Modell geladen in {load_ms:.0f} ms")

        input_details = interpreter.get_input_details()
        output_details = interpreter.get_output_details()
        in_h = input_details[0]['shape'][1]
        in_w = input_details[0]['shape'][2]
        info(f"Eingabegröße: {in_w}x{in_h}, dtype: {input_details[0]['dtype'].__name__}")

        img = create_test_image(in_w, in_h)
        import cv2
        rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
        resized = cv2.resize(rgb, (in_w, in_h))
        inp = np.expand_dims(resized, axis=0)
        if input_details[0]['dtype'] == np.float32:
            inp = (inp.astype(np.float32) - 127.5) / 127.5

        interpreter.set_tensor(input_details[0]['index'], inp)

        t1 = time.perf_counter()
        interpreter.invoke()
        infer_ms = (time.perf_counter() - t1) * 1000

        ok(f"CPU Inferenz abgeschlossen in {infer_ms:.1f} ms (deutlich langsamer als Coral)")

        scores = interpreter.get_tensor(output_details[2]['index'])[0]
        classes = interpreter.get_tensor(output_details[1]['index'])[0]
        high_scores = [(int(classes[i]), float(scores[i])) for i in range(len(scores)) if scores[i] > 0.1]
        if high_scores:
            ok(f"{len(high_scores)} Objekt(e) über Score 0.1:")
            for cls_id, sc in sorted(high_scores, key=lambda x: -x[1])[:5]:
                label = labels.get(cls_id + 1, labels.get(cls_id, str(cls_id)))
                print(f"    • {label} ({sc:.2%})")
        else:
            info("Keine Objekte über Score 0.1 (synthetisches Bild – normal)")

        print(f"\n{YELLOW}{BOLD}  ⚡ CPU-FALLBACK FUNKTIONIERT! Inferenz in {infer_ms:.1f} ms{RESET}")
        return True

    except Exception as e:
        err(f"CPU Inferenz fehlgeschlagen: {e}")
        return False


def print_model_download_instructions(model_path: str):
    """Erklärt welche Modelle heruntergeladen werden müssen."""
    head("MODELL HERUNTERLADEN")
    print("""
  Das COCO SSD MobileNet v2 EdgeTPU-Modell von Google Coral:

  # 1. EdgeTPU-Modell (für Coral USB):
  cd /app/models
  curl -LO https://github.com/google-coral/test_data/raw/master/ssd_mobilenet_v2_coco_quant_postprocess_edgetpu.tflite
  # Umbenennen damit es zum Pfad in config.yaml passt:
  mv ssd_mobilenet_v2_coco_quant_postprocess_edgetpu.tflite \\
     coco_ssd_mobilenet_v2_coco_quant_postprocess_edgetpu.tflite

  # 2. CPU-Modell (Fallback, falls kein Coral):
  curl -LO https://github.com/google-coral/test_data/raw/master/ssd_mobilenet_v2_coco_quant_postprocess.tflite
  mv ssd_mobilenet_v2_coco_quant_postprocess.tflite \\
     coco_ssd_mobilenet_v2_coco_quant_postprocess.tflite

  Alternativ über das Coral Modell-Zoo:
  https://coral.ai/models/object-detection/
  → "MobileNet SSD v2 (COCO)" herunterladen
""")

    # Prüfe ob Vogelmodell gesucht wird
    if "bird" in model_path.lower() or "bavarian" in model_path.lower():
        print("""
  Das Bavarian Birds EdgeTPU-Modell:

  ⚠️  Dieses Modell ist NICHT öffentlich verfügbar und muss selbst trainiert werden.

  Optionen:
  A) Eigenes Training auf Google Colab mit dem iNaturalist Bavaria Datensatz:
     https://colab.research.google.com/github/google-coral/tutorials/blob/master/retrain_classification_ptq_tf2.ipynb

  B) Generic iNat Bird Classifier von Coral:
     https://github.com/google-coral/edgetpu/blob/master/test_data/inat_bird_classifier_edgetpu.tflite
     (erkennt viele internationale Vogelarten, nicht Bayern-spezifisch)

  C) Platzhalter-Modell mit allgemeinen Vögeln:
     cd /app/models
     curl -LO https://github.com/google-coral/test_data/raw/master/inat_bird_classifier_edgetpu.tflite
     mv inat_bird_classifier_edgetpu.tflite bavarian_birds_edgetpu.tflite

  Für Option C: Labels-Datei anpassen unter /app/config/bavarian_birds_common.txt
""")


def main():
    parser = argparse.ArgumentParser(description="TAM-spy Coral TPU Test")
    parser.add_argument("--model",  default=DEFAULT_MODEL,  help="Pfad zum .tflite Modell")
    parser.add_argument("--labels", default=DEFAULT_LABELS, help="Pfad zur Labels-Datei")
    parser.add_argument("--skip-coral", action="store_true", help="Coral-Test überspringen, nur CPU testen")
    args = parser.parse_args()

    print(f"\n{BOLD}{'='*60}{RESET}")
    print(f"{BOLD}  TAM-spy Coral TPU Diagnose{RESET}")
    print(f"{BOLD}{'='*60}{RESET}")
    print(f"  Modell:  {args.model}")
    print(f"  Labels:  {args.labels}")

    labels = load_labels(args.labels)
    if labels:
        ok(f"Labels geladen: {len(labels)} Einträge")
    else:
        warn(f"Keine Labels geladen von: {args.labels}")

    # Checks
    usb_found    = check_usb_coral()
    lib_found    = check_libedgetpu()
    pycoral_ok, make_interp, common_mod, detect_mod = check_pycoral()
    tflite_ok, tflite_mod = check_tflite_runtime()

    # Inferenz
    coral_success = False
    cpu_success = False

    if not args.skip_coral and pycoral_ok:
        coral_success = run_inference_coral(args.model, labels, make_interp, common_mod, detect_mod)

    if not coral_success and tflite_ok:
        cpu_success = run_inference_cpu(args.model, labels, tflite_mod)

    if not coral_success and not cpu_success and not pycoral_ok and not tflite_ok:
        err("Weder pycoral noch tflite-runtime verfügbar – keine Inferenz möglich")
        print_model_download_instructions(args.model)

    # ── Zusammenfassung ──────────────────────────────────────────────────────
    head("ZUSAMMENFASSUNG")
    status_lines = [
        ("USB Coral erkannt",      usb_found),
        ("libedgetpu installiert", lib_found),
        ("pycoral verfügbar",      pycoral_ok),
        ("tflite-runtime verfügbar", tflite_ok),
        ("Coral Inferenz OK",      coral_success),
        ("CPU Inferenz OK",        cpu_success),
    ]
    for label_s, status in status_lines:
        sym = f"{GREEN}✅{RESET}" if status else f"{YELLOW}⚠️ {RESET}"
        print(f"  {sym} {label_s}")

    if coral_success:
        print(f"\n{GREEN}{BOLD}  → Coral TPU ist einsatzbereit!{RESET}")
        print(f"  → Dashboard zeigt: Coral aktiv (grün)")
    elif cpu_success:
        print(f"\n{YELLOW}{BOLD}  → CPU-Modus aktiv (kein Coral, aber Erkennung funktioniert){RESET}")
        print(f"  → Dashboard zeigt: CPU Modus (gelb)")
        if not usb_found:
            info("Stecke den Coral USB Stick an und starte den Container neu")
    else:
        print(f"\n{RED}{BOLD}  → Nur Bewegungserkennung verfügbar{RESET}")
        print(f"  → Dashboard zeigt: Nur Bewegung (grau)")
        print_model_download_instructions(args.model)

    print()
    return 0 if (coral_success or cpu_success) else 1


if __name__ == "__main__":
    sys.exit(main())
