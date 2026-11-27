import { TONE_VAR, type FolderTone } from "../folderLook";

const OUTLINE = "M1 2H6L7.5 3.5H15V13H1Z";

/** A folder filled with its main state color, with the lower-right corner in a second state's color. */
export function FolderIcon(props: { main: FolderTone; second?: FolderTone }) {
  return (
    <svg
      class="ficon fi"
      classList={{ [`fi-${props.main}`]: true, [`fi2-${props.second}`]: !!props.second }}
      viewBox="0 0 16 14"
      aria-hidden="true"
      style={{ "--fi-main": `var(${TONE_VAR[props.main]})`, "--fi-second": `var(${TONE_VAR[props.second ?? props.main]})` }}
    >
      <path class="fi-body" d={OUTLINE} />
      {props.second && <path class="fi-corner" d="M15 4V13H5.5Z" />}
      <path class="fi-edge" d={OUTLINE} />
    </svg>
  );
}
