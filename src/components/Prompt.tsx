import { createSignal, Show } from "solid-js";
import { Modal } from "./common";

interface PromptReq {
  title: string;
  label: string;
  value: string;
  resolve: (v: string | null) => void;
}
const [req, setReq] = createSignal<PromptReq | null>(null);

/** In-app replacement for window.prompt (which is unreliable in webviews). */
export function promptText(title: string, label: string, value = ""): Promise<string | null> {
  req()?.resolve(null);
  return new Promise((resolve) => setReq({ title, label, value, resolve }));
}

export function PromptHost() {
  const done = (v: string | null) => {
    const r = req();
    setReq(null);
    r?.resolve(v);
  };
  return (
    <Show when={req()}>
      {(r) => {
        let input!: HTMLInputElement;
        return (
          <Modal title={r().title} onClose={() => done(null)}>
            <form
              class="prompt-form"
              onSubmit={(e) => {
                e.preventDefault();
                done(input.value);
              }}
            >
              <label>
                {r().label}
                <input ref={(el) => ((input = el), setTimeout(() => (el.focus(), el.select())))} value={r().value} spellcheck={false} />
              </label>
              <div class="modal-actions">
                <button type="button" class="tb-btn" onClick={() => done(null)}>Cancel</button>
                <button type="submit" class="tb-btn primary">OK</button>
              </div>
            </form>
          </Modal>
        );
      }}
    </Show>
  );
}
