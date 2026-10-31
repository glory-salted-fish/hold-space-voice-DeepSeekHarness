window.__ModuleLoader__.load({
  id: 'holdspace',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'holdspace';
    const HOLD_MS = 220;
    const MAX_SECONDS = 60;

    const zh = {
      action: '按住空格说话',
      listening: '正在聆听…',
      transcribing: '正在识别…',
      empty: '没有识别到语音。',
      denied: '麦克风权限被拒绝。',
      noMic: '没有找到可用的麦克风。',
      unsupported: '当前页面无法访问麦克风。',
      serviceMissing: '本地语音服务未启用，请在插件页启用 Voice Input。',
      prepareNeeded: '语音模型尚未准备：点击输入框旁的麦克风完成下载后重试。',
      language: '当前语音模型不支持该语言。',
      failed: '语音识别失败。',
      insertFailed: '识别结果无法插入草稿，请重试。',
    };
    const en = {
      action: 'Hold Space to talk',
      listening: 'Listening…',
      transcribing: 'Transcribing…',
      empty: 'No speech was recognized.',
      denied: 'Microphone permission was denied.',
      noMic: 'No microphone is available.',
      unsupported: 'This page cannot access the microphone.',
      serviceMissing: 'Local speech is not enabled; turn on Voice Input in Plugins.',
      prepareNeeded: 'The speech model is not prepared: use the microphone beside the composer to download it, then retry.',
      language: 'The speech model does not support this language.',
      failed: 'Speech recognition failed.',
      insertFailed: 'The transcript could not be inserted into the draft.',
    };

    /* ------------------------------------------------------------------ */
    /* Local speech service, mounted by the Voice Input bundle.            */
    /* ------------------------------------------------------------------ */

    let speech = null;
    let runtime = null;

    function resolveSpeech() {
      if (speech) return speech;
      if (!runtime) return null;
      try {
        if (runtime.remote && runtime.remote.speech) return runtime.remote.speech;
      } catch (error) {
        /* remote unavailable */
      }
      try {
        if (typeof runtime.get === 'function') {
          const direct = runtime.get('remote.speech');
          if (direct) return direct;
          const remote = runtime.get('remote');
          if (remote && remote.speech) return remote.speech;
        }
      } catch (error) {
        /* service not injected */
      }
      return null;
    }

    /* ------------------------------------------------------------------ */
    /* Shared per-session state (both slot occupants render from it).      */
    /* ------------------------------------------------------------------ */

    const sessions = new Map();

    function stateOf(sessionId) {
      let state = sessions.get(sessionId);
      if (!state) {
        state = { phase: 'idle', interim: '', message: '', detail: '', listeners: new Set(), timer: 0 };
        sessions.set(sessionId, state);
      }
      return state;
    }

    function emit(state) {
      for (const listener of state.listeners) listener();
    }

    function set(state, next) {
      Object.assign(state, next);
      emit(state);
    }

    function flash(state, key, detail) {
      window.clearTimeout(state.timer);
      state.message = key;
      state.detail = detail || '';
      emit(state);
      state.timer = window.setTimeout(() => {
        state.message = '';
        state.detail = '';
        emit(state);
      }, 5200);
    }

    function useVoiceState(sessionId) {
      const state = stateOf(sessionId);
      const [, bump] = React.useReducer((value) => value + 1, 0);
      React.useEffect(() => {
        state.listeners.add(bump);
        return () => {
          state.listeners.delete(bump);
        };
      }, [state]);
      return state;
    }

    /* ------------------------------------------------------------------ */
    /* Microphone capture: 16 kHz mono PCM16 WAV, the provider's format.   */
    /* ------------------------------------------------------------------ */

    function resample(input, fromRate, toRate) {
      if (fromRate === toRate) return input;
      const ratio = fromRate / toRate;
      const length = Math.max(1, Math.floor(input.length / ratio));
      const output = new Float32Array(length);
      for (let index = 0; index < length; index += 1) {
        const position = index * ratio;
        const left = Math.floor(position);
        const right = Math.min(input.length - 1, left + 1);
        const weight = position - left;
        output[index] = input[left] * (1 - weight) + input[right] * weight;
      }
      return output;
    }

    function encodeWav(samples, sampleRate) {
      const buffer = new ArrayBuffer(44 + samples.length * 2);
      const view = new DataView(buffer);
      const text = (offset, value) => {
        for (let index = 0; index < value.length; index += 1) {
          view.setUint8(offset + index, value.charCodeAt(index));
        }
      };
      text(0, 'RIFF');
      view.setUint32(4, 36 + samples.length * 2, true);
      text(8, 'WAVE');
      text(12, 'fmt ');
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true);
      view.setUint16(22, 1, true);
      view.setUint32(24, sampleRate, true);
      view.setUint32(28, sampleRate * 2, true);
      view.setUint16(32, 2, true);
      view.setUint16(34, 16, true);
      text(36, 'data');
      view.setUint32(40, samples.length * 2, true);
      let offset = 44;
      for (let index = 0; index < samples.length; index += 1) {
        const sample = Math.max(-1, Math.min(1, samples[index]));
        view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
        offset += 2;
      }
      return buffer;
    }

    function toBase64(buffer) {
      const bytes = new Uint8Array(buffer);
      let binary = '';
      const chunk = 0x8000;
      for (let index = 0; index < bytes.length; index += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(index, index + chunk));
      }
      return btoa(binary);
    }

    function microphoneAvailable() {
      return typeof navigator !== 'undefined' && !!navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function';
    }

    function createCapture() {
      let stream = null;
      let audio = null;
      let source = null;
      let processor = null;
      let sink = null;
      let closed = false;
      let cancelled = false;
      const chunks = [];

      const teardown = () => {
        closed = true;
        try {
          if (processor) {
            processor.onaudioprocess = null;
            processor.disconnect();
          }
        } catch (error) {
          /* already detached */
        }
        try {
          if (source) source.disconnect();
        } catch (error) {
          /* already detached */
        }
        try {
          if (sink) sink.disconnect();
        } catch (error) {
          /* already detached */
        }
        if (stream) {
          for (const track of stream.getTracks()) track.stop();
          stream = null;
        }
        if (audio && audio.state !== 'closed') {
          audio.close().catch(() => {});
        }
        audio = null;
      };

      return {
        async start() {
          if (!microphoneAvailable()) throw namedError('unsupported', 'microphone-unavailable');
          stream = await navigator.mediaDevices.getUserMedia({
            audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          });
          if (cancelled) {
            teardown();
            throw namedError('cancelled', 'capture-cancelled');
          }
          const Ctor = window.AudioContext || window.webkitAudioContext;
          if (!Ctor) throw namedError('unsupported', 'audio-context-unavailable');
          audio = new Ctor({ sampleRate: 16000 });
          if (audio.state === 'suspended') await audio.resume();
          if (cancelled) {
            teardown();
            throw namedError('cancelled', 'capture-cancelled');
          }
          source = audio.createMediaStreamSource(stream);
          processor = audio.createScriptProcessor(4096, 1, 1);
          processor.onaudioprocess = (event) => {
            if (closed) return;
            chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
          };
          sink = audio.createGain();
          sink.gain.value = 0;
          source.connect(processor);
          processor.connect(sink);
          sink.connect(audio.destination);
        },
        async stop() {
          const rate = audio && audio.sampleRate ? audio.sampleRate : 16000;
          teardown();
          let total = 0;
          for (const chunk of chunks) total += chunk.length;
          const merged = new Float32Array(total);
          let offset = 0;
          for (const chunk of chunks) {
            merged.set(chunk, offset);
            offset += chunk.length;
          }
          chunks.length = 0;
          const samples = resample(merged, rate, 16000);
          return { wav: encodeWav(samples, 16000), seconds: samples.length / 16000 };
        },
        cancel() {
          cancelled = true;
          teardown();
          chunks.length = 0;
        },
      };
    }

    function namedError(name, message) {
      const error = new Error(message);
      error.name = name;
      return error;
    }

    function describeError(error) {
      const name = error && error.name ? String(error.name) : '';
      const message = error && error.message ? String(error.message) : String(error || '');
      if (name === 'NotAllowedError' || name === 'SecurityError' || /permission|denied/i.test(message)) return 'denied';
      if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'noMic';
      if (name === 'unsupported') return 'unsupported';
      if (/prepare the local speech provider/i.test(message)) return 'prepareNeeded';
      if (/language/i.test(message) && /support|accept/i.test(message)) return 'language';
      return 'failed';
    }

    /* ------------------------------------------------------------------ */
    /* Composer toolbar button: owns the Space key state machine.          */
    /* ------------------------------------------------------------------ */

    function MicButton(props) {
      const sessionId = props.sessionId;
      const state = useVoiceState(sessionId);
      const actionsRef = React.useRef(props.inputActions);
      actionsRef.current = props.inputActions;
      const manualRef = React.useRef(null);
      const toggleRef = React.useRef(null);
      const canRecord = microphoneAvailable();
      const t = translate(props.t);

      React.useEffect(() => {
        if (!canRecord) return undefined;
        const state = stateOf(sessionId);
        let held = null;

        const isSpace = (event) =>
          event.code === 'Space' || event.key === ' ' || event.key === 'Spacebar' || event.keyCode === 32;

        /* Only the composer editor (contenteditable) participates; plain inputs keep normal Space. */
        const isEditable = (node) => !!node && node.isContentEditable === true;

        const insert = (text, span) => {
          try {
            return span ? actionsRef.current.insertText(text, span) : false;
          } catch (error) {
            return false;
          }
        };

        const captureSpan = () => {
          try {
            return actionsRef.current.captureInsertion();
          } catch (error) {
            return null;
          }
        };

        const reset = () => set(state, { phase: 'idle', interim: '' });

        const insertTranscript = (text, span) => {
          let inserted = insert(text, span);
          if (!inserted) inserted = insert(text, captureSpan());
          if (!inserted) flash(state, 'insertFailed');
        };

        const finish = async (record) => {
          if (record.done) return;
          record.done = true;
          if (manualRef.current === record) manualRef.current = null;
          window.clearTimeout(record.timer);
          window.clearTimeout(record.maxTimer);
          if (!record.capture) {
            reset();
            return;
          }
          set(state, { phase: 'transcribing', interim: '' });
          let audio;
          try {
            audio = await record.capture.stop();
          } catch (error) {
            reset();
            flash(state, 'failed');
            return;
          }
          if (!audio || audio.seconds < 0.25 || audio.wav.byteLength < 2048) {
            reset();
            flash(state, 'empty');
            return;
          }
          let service = resolveSpeech();
          if (!service) {
            await new Promise((resolve) => window.setTimeout(resolve, 250));
            service = resolveSpeech();
          }
          if (!service) {
            reset();
            flash(state, 'serviceMissing');
            return;
          }
          let result;
          try {
            result = await service.transcribe({ audioBase64: toBase64(audio.wav) }, record.abort.signal);
          } catch (error) {
            reset();
            flash(state, describeError(error));
            return;
          }
          if (!result || result.ok !== true) {
            const error = result && result.error ? result.error : null;
            reset();
            flash(state, describeError(error), error && error.message ? String(error.message) : '');
            return;
          }
          const text = result.value && result.value.text ? String(result.value.text).trim() : '';
          reset();
          if (!text) {
            flash(state, 'empty');
            return;
          }
          insertTranscript(text, record.span);
        };

        const begin = () => {
          const record = held;
          if (!record || record.started) return;
          record.started = true;
          record.abort = new AbortController();
          record.capture = createCapture();
          set(state, { phase: 'listening', interim: '' });
          record.startPromise = record.capture.start().catch((error) => {
            record.startError = error;
            if (record.capture) record.capture.cancel();
          });
          record.startPromise.then(() => {
            if (record.done) return;
            if (record.startError) {
              record.done = true;
              reset();
              flash(state, describeError(record.startError));
              return;
            }
            if (record.stopRequested) finish(record);
          });
          record.maxTimer = window.setTimeout(() => {
            if (held === record) {
              held = null;
              record.stopRequested = true;
              finish(record);
            }
          }, MAX_SECONDS * 1000);
        };

        const stopRecord = (record) => {
          record.stopRequested = true;
          if (record.startPromise) {
            record.startPromise.then(() => {
              if (!record.done && !record.startError) finish(record);
            });
          } else {
            finish(record);
          }
        };

        const onKeyDown = (event) => {
          if (event.key === 'Escape' && (held || manualRef.current)) {
            event.preventDefault();
            const record = held || manualRef.current;
            held = null;
            manualRef.current = null;
            window.clearTimeout(record.timer);
            window.clearTimeout(record.maxTimer);
            record.done = true;
            if (record.capture) record.capture.cancel();
            reset();
            return;
          }
          if (!isSpace(event)) return;
          if (event.isComposing || event.keyCode === 229) return;
          if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
          if (!isEditable(event.target)) return;
          if (held) {
            event.preventDefault();
            return;
          }
          const span = captureSpan();
          if (!span) return;
          event.preventDefault();
          held = {
            span,
            started: false,
            done: false,
            stopRequested: false,
            startError: null,
            startPromise: null,
            capture: null,
            abort: null,
            timer: 0,
            maxTimer: 0,
          };
          const record = held;
          record.timer = window.setTimeout(begin, HOLD_MS);
        };

        const onKeyUp = (event) => {
          if (!isSpace(event)) return;
          const record = held;
          if (!record) return;
          event.preventDefault();
          held = null;
          window.clearTimeout(record.timer);
          if (!record.started) {
            insert(' ', record.span);
            return;
          }
          stopRecord(record);
        };

        const onBlur = () => {
          const record = held;
          if (!record) return;
          held = null;
          window.clearTimeout(record.timer);
          window.clearTimeout(record.maxTimer);
          if (!record.started) {
            insert(' ', record.span);
            return;
          }
          record.done = true;
          if (record.capture) record.capture.cancel();
          reset();
        };

        const onToggle = () => {
          if (held) return;
          const record = manualRef.current;
          if (record) {
            manualRef.current = null;
            stopRecord(record);
            return;
          }
          const span = captureSpan();
          if (!span) return;
          const next = {
            span,
            started: false,
            done: false,
            stopRequested: false,
            startError: null,
            startPromise: null,
            capture: null,
            abort: null,
            timer: 0,
            maxTimer: 0,
          };
          manualRef.current = next;
          held = next;
          begin();
        };

        document.addEventListener('keydown', onKeyDown, true);
        document.addEventListener('keyup', onKeyUp, true);
        window.addEventListener('blur', onBlur);
        toggleRef.current = onToggle;

        return () => {
          document.removeEventListener('keydown', onKeyDown, true);
          document.removeEventListener('keyup', onKeyUp, true);
          window.removeEventListener('blur', onBlur);
          toggleRef.current = null;
          const record = held || manualRef.current;
          held = null;
          manualRef.current = null;
          if (record) {
            window.clearTimeout(record.timer);
            window.clearTimeout(record.maxTimer);
            record.done = true;
            if (record.capture) record.capture.cancel();
          }
        };
      }, [sessionId, canRecord]);

      const recording = state.phase === 'listening';
      const busy = state.phase === 'transcribing';

      return h(
        React.Fragment,
        null,
        h('style', { key: 'style', dangerouslySetInnerHTML: { __html: CSS } }),
        h(
          'button',
          {
            key: 'button',
            type: 'button',
            className: 'hsv-button',
            'data-recording': recording ? 'true' : 'false',
            disabled: !canRecord,
            'aria-label': t('action'),
            'aria-pressed': recording ? 'true' : 'false',
            title: canRecord ? t('action') : t('unsupported'),
            onMouseDown: (event) => event.preventDefault(),
            onClick: () => {
              if (toggleRef.current) toggleRef.current();
            },
          },
          recording ? h('span', { className: 'hsv-dot' }) : busy ? h('span', { className: 'hsv-ring' }) : micIcon(),
        ),
      );
    }

    /* ------------------------------------------------------------------ */
    /* Floating status pill inside the composer card.                      */
    /* ------------------------------------------------------------------ */

    function VoiceOverlay(props) {
      const state = useVoiceState(props.sessionId);
      const t = translate(props.t);
      const listening = state.phase === 'listening';
      const transcribing = state.phase === 'transcribing';
      if (!listening && !transcribing && !state.message) return null;
      const label = state.message ? t(state.message) : listening ? t('listening') : t('transcribing');
      return h(
        React.Fragment,
        null,
        h('style', { key: 'style', dangerouslySetInnerHTML: { __html: CSS } }),
        h(
          'div',
          {
            key: 'pill',
            className: 'hsv-pill',
            'data-error': state.message ? 'true' : 'false',
            role: 'status',
            'aria-live': 'polite',
            title: state.detail || undefined,
          },
          listening ? h('span', { className: 'hsv-dot' }) : null,
          h('span', { className: 'hsv-label' }, label),
          state.interim ? h('span', { className: 'hsv-interim' }, state.interim) : null,
        ),
      );
    }

    /* ------------------------------------------------------------------ */

    function translate(t) {
      return (key) => {
        if (typeof t === 'function') {
          const value = t(key);
          if (typeof value === 'string' && value !== key) return value;
        }
        return key;
      };
    }

    function micIcon() {
      return h(
        'svg',
        {
          className: 'hsv-icon',
          viewBox: '0 0 24 24',
          width: 16,
          height: 16,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        h('rect', { x: 9, y: 3, width: 6, height: 11, rx: 3 }),
        h('path', { d: 'M5.5 11.5a6.5 6.5 0 0 0 13 0' }),
        h('path', { d: 'M12 18v3' }),
      );
    }

    const CSS = `
.hsv-button{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;flex:0 0 auto;padding:0;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:background-color .15s ease,color .15s ease}
.hsv-button:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.hsv-button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.hsv-button:disabled{opacity:.45;cursor:not-allowed}
.hsv-button[data-recording="true"]{color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-bg-layer-2)}
.hsv-icon{display:block;pointer-events:none}
.hsv-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-error-primary);animation:hsv-pulse 1.1s ease-in-out infinite}
.hsv-ring{width:12px;height:12px;border-radius:50%;border:2px solid var(--dsw-alias-brand-primary);border-top-color:transparent;animation:hsv-spin .9s linear infinite}
.hsv-pill{display:inline-flex;align-items:center;gap:8px;max-width:100%;padding:4px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.hsv-pill[data-error="true"]{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.hsv-label{flex:0 0 auto}
.hsv-interim{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary)}
@keyframes hsv-pulse{0%,100%{opacity:.35;transform:scale(.8)}50%{opacity:1;transform:scale(1.15)}}
@keyframes hsv-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion: reduce){.hsv-dot,.hsv-ring{animation:none}}
`;

    /* ------------------------------------------------------------------ */

    function apply(ctx) {
      ctx.effect(() => {
        runtime = ctx;
        let injection = null;
        try {
          injection = ctx.inject(['remote.speech'], (inner) => {
            try {
              const remote = inner.remote || (typeof inner.get === 'function' ? inner.get('remote') : null);
              speech = remote && remote.speech ? remote.speech : null;
            } catch (error) {
              speech = null;
            }
          });
        } catch (error) {
          speech = null;
        }
        return () => {
          runtime = null;
          speech = null;
          if (injection && typeof injection.dispose === 'function') injection.dispose();
        };
      });
      ctx.effect(() => ctx.locale.register(NS, { zh, en }));
      ctx.effect(() =>
        ctx.slots.inject('conversation.input.right', () =>
          ctx.slots.register(
            { name: 'conversation.input.right', id: 'hold-space-voice', order: 61, locale: NS },
            MicButton,
          ),
        ),
      );
      ctx.effect(() =>
        ctx.slots.inject('conversation.input.overlay', () =>
          ctx.slots.register(
            { name: 'conversation.input.overlay', id: 'hold-space-voice-status', order: 40, locale: NS },
            VoiceOverlay,
          ),
        ),
      );
    }

    return { inject: ['slots', 'locale', 'remote'], apply };
  },
});
