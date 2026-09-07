// worklet-synth.js — AudioWorkletProcessor 'redistribution-synth'.
//
// NOT standalone: app.js fetches synth.js + this file and concatenates them
// into one Blob URL for addModule (the AudioWorklet global scope has no
// importScripts). Assumes RDSynth is already on the global.
//
// 0 in / 1 out. The voice bank is mono; both output channels carry it. Notes
// arrive by postMessage; the active-voice count is posted back on change so
// the main thread can scale the effect's bit budget (budgetScale) — the main
// thread is the bus between the two worklets (no cross-worklet messaging).
'use strict';
(function () {
  var FS_GUESS = sampleRate; // AudioWorkletGlobalScope provides sampleRate

  class RedistributionSynth extends AudioWorkletProcessor {
    constructor() {
      super();
      this.synth = RDSynth.Synth(FS_GUESS, { waveform: 'saw' });
      this.waveform = 'saw';
      this.voices = 0;
      this.tmp = null;
      var self = this;
      this.port.onmessage = function (e) {
        var m = e.data;
        if (m.type === 'note') {          // {note, on, vel}
          if (m.on) self.synth.noteOn(m.note, m.vel);
          else self.synth.noteOff(m.note);
        } else if (m.type === 'alloff') {
          self.synth.allOff();
        } else if (m.type === 'waveform') {
          // the bank holds per-voice filter/envelope state, so a waveform
          // switch rebuilds it — audible reset of held notes is acceptable
          // for an advanced param (voices re-steal from silence)
          if (m.waveform && m.waveform !== self.waveform) {
            self.waveform = m.waveform;
            self.synth = RDSynth.Synth(FS_GUESS, { waveform: m.waveform });
            self.voices = 0;
            self.port.postMessage({ type: 'voices', count: 0 });
          }
        }
      };
    }

    process(inputs, outputs) {
      var out = outputs[0];
      var oL = out[0], oR = out[1] || out[0];
      var n = oL.length;
      if (!this.tmp || this.tmp.length !== n) this.tmp = new Float32Array(n);
      var tmp = this.tmp;
      this.synth.render(tmp, n);
      var c = this.synth.activeCount();
      if (c !== this.voices) {
        this.voices = c;
        this.port.postMessage({ type: 'voices', count: c });
      }
      for (var i = 0; i < n; i++) { oL[i] = tmp[i]; oR[i] = tmp[i]; }
      // keep the node alive while the page owns it (it disconnects explicitly)
      return true;
    }
  }
  registerProcessor('redistribution-synth', RedistributionSynth);
})();