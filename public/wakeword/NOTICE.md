# Wake-word models

`melspectrogram.onnx`, `embedding_model.onnx` and `hey_jarvis_v0.1.onnx` are
the pre-trained models from [openWakeWord](https://github.com/dscripka/openWakeWord)
by David Scripka, release v0.5.1.

They are licensed under
[CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/)
(non-commercial use, with attribution, share-alike). The openWakeWord code is
Apache 2.0. The embedding model re-implements Google's speech_embedding
(Apache 2.0).

Used unmodified for local, in-browser "Hey Jarvis" detection; audio never
leaves the device for wake-word detection.
