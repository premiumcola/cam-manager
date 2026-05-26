<!--
Example diag-CLI output produced by:
    docker exec squirreling-sightings python -m app.scripts.diag_timelapse \
        reolink_rlc811a_squirreltownnutbar_183 --date all

The 2026-05-12 sunrise fixtures the prompt referenced are not yet on
disk in this environment — the CLI picked up whichever <mp4>.qa.json
sidecars happened to be present in storage/timelapse/. Replace this
example with real 2026-05-12 output once the fixtures land and a
sunrise build runs through _write_video → write_qa_sidecar.
-->

# Timelapse quality · `reolink_rlc811a_squirreltownnutbar_183`
Range: all dates (1 sidecar)

## 2026-04-14_074902_custom_1min_to_10sec_squirreltownnutbar.mp4    ● red
- declared 10 fps · effective 12.28 fps · unique 0.44 fps
- dup_ratio 96 % · freezes 1 (total 2.20 s)
- top reject: (no capture stats — sidecar lacks _stats.json)
- build profile: `custom`

## Aggregate (1 build)
- mean unique_fps: 0.44
- dominant reject reason: (none recorded)
- grade distribution: red=1
