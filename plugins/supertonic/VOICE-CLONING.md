# Adding a local voice

CliDeck reads Supertonic 3 voice profiles; a recording must first be converted
into a profile. The community converter used for the bundled voices is
[supertonic3-voice-clone](https://github.com/saurabhv749/supertonic3-voice-clone).

The restored Apple Silicon checkout is at
`/Users/rusty/Projects/supertonic3-voice-clone`. Its committed `MAC-SETUP.md`
contains installation, pinned model downloads, reference preparation, training,
and preview commands. `requirements-macos.lock.txt` records the verified Python
3.12 environment. TTS training uses MPS and SpeechBrain's identity encoder uses
CPU. The Mac adjustments are kept in that checkout, outside CliDeck's runtime.

1. Prepare a reference WAV with `prepare_reference.py`, passing the original
   clips in order. It writes 16 kHz mono audio plus a source inventory and never
   overwrites the original recordings.
2. Run `train_style.py --name <name> --target-wav-path <reference.wav>
   --reference-style auto --num-steps 500`. Run from the cloner checkout root.
   The output is `logs/<name>/<name>.json`.
3. Generate a listening preview with `generate.py --style <profile.json>
   --text '<preview sentence>' --lang en`. The WAV appears in `samples/`.
4. Copy the profile to this plugin's `public/voices/<id>.json`. Encode the WAV
   as `public/voices/<id>-preview.mp3` with FFmpeg. Keep existing voice IDs stable.
5. Add the profile URL to `VOICE_STYLE_URLS` in `client.js` and its named option
   and preview path to the voice setting in `clideck-plugin.json`. Update the
   plugin version and validate with `clideck plugin validate plugins/supertonic`.

Profiles must contain finite float32 tensors with dimensions `[1,50,256]` for
`style_ttl` and `[1,8,16]` for `style_dp`. Keep source metadata accurate; it is
provenance, not an inference setting. Listen to actual generated audio to judge
the voice; the training loss alone cannot establish listening quality.

Reload the plugin inventory (Settings or an engine restart) after adding voice
options, and refresh the browser to load the updated client. Source recordings
and the training environment are not shipped inside CliDeck.

## Voice batch: 2026-10-29

The eight additions use the user's local `Downloads/voices` collection:

| Voice | Reference clips |
| --- | --- |
| Jake | `processed/jake/good1.ogg` through `good6.ogg` |
| Kabbi | `processed/kabbi/good1.ogg` through `good6.ogg` |
| Lilly | `processed/lilly/good1.ogg` through `good5.ogg` |
| Lola | `processed/lola/good1.ogg` through `good3.ogg` |
| Nikki | `processed/nikki/good1.ogg` through `good14.ogg` |
| Transi | `processed/transi/good1.ogg` through `good15.ogg` |
| Myers | `raw/Myers/good.mp3` and `good2.mp3` |
| Chun-Li | Twelve largest top-level WAV clips in `raw/Chun-Li`; excludes `Efforts` |

Lilly and Lola are separate curated selections of the same original speaker;
both are kept for listening comparison. Tifa and Emma were already bundled as
Female 1 and Female 2. Their existing profiles are unchanged. Mika keeps the
`mike` ID for saved preferences; Dov is no longer bundled.

This batch uses the preparation and 500-step training procedure above. Each
reference has an adjacent `.sources.json` inventory with original file hashes.
The generated English previews use 12 synthesis steps and the same sentence:
"Hello. This is a preview of my voice in CliDeck. Let me know what you think."
These are candidate voices for listening comparison, not a quality ranking.
