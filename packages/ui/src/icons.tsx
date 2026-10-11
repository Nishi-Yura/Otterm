/**
 * otterm's built-in icon set.
 *
 * These are our own drawings, made from simple geometric primitives in the
 * same visual language as Lucide (24x24 grid, 2px stroke, round caps and
 * joins). No Lucide source is copied. Mods refer to icons by these names in
 * their `icon:` field, so the names follow the Lucide naming scheme.
 *
 * Each entry is the SVG child markup only; `Icon` wraps it in an `<svg>`.
 */
import type { JSX } from "solid-js";

export const ICONS: Record<string, string> = {
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  "folder-open": '<path d="M3 19V7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2v1"/><path d="M3 19l2.5-7.5H21l-2.5 7.5z"/>',
  "folder-plus":
    '<path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><line x1="12" y1="10.5" x2="12" y2="16.5"/><line x1="9" y1="13.5" x2="15" y2="13.5"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><polyline points="14 3 14 8 19 8"/>',
  "file-plus":
    '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><polyline points="14 3 14 8 19 8"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/>',
  "file-text":
    '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><polyline points="14 3 14 8 19 8"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="15" y2="17"/>',
  "file-json":
    '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><polyline points="14 3 14 8 19 8"/><path d="M10.5 12.5Q9.5 12.5 9.5 13.5V15Q9.5 15.5 9 15.5Q9.5 15.5 9.5 16V17.5Q9.5 18.5 10.5 18.5"/><path d="M13.5 12.5Q14.5 12.5 14.5 13.5V15Q14.5 15.5 15 15.5Q14.5 15.5 14.5 16V17.5Q14.5 18.5 13.5 18.5"/>',
  "file-code":
    '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><polyline points="14 3 14 8 19 8"/><polyline points="10 12.5 8 15 10 17.5"/><polyline points="14 12.5 16 15 14 17.5"/>',
  "git-branch":
    '<line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
  git: '<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="12" r="2.5"/><line x1="6" y1="8.5" x2="6" y2="15.5"/><path d="M6 12h9.5"/>',
  "git-commit":
    '<circle cx="12" cy="12" r="4"/><line x1="3" y1="12" x2="8" y2="12"/><line x1="16" y1="12" x2="21" y2="12"/>',
  "refresh-cw":
    '<path d="M20 12a8 8 0 0 1-14.3 4.9"/><path d="M4 12a8 8 0 0 1 14.3-4.9"/><polyline points="20 4 20 8.5 15.5 8.5"/><polyline points="4 20 4 15.5 8.5 15.5"/>',
  "rotate-ccw": '<path d="M4 12a8 8 0 1 0 2.35-5.65"/><polyline points="4 4 4 9 9 9"/>',
  check: '<polyline points="4 12.5 9.5 18 20 6.5"/>',
  x: '<line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/>',
  "alert-triangle":
    '<path d="M10.3 4.2L2.6 17.5A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z"/><line x1="12" y1="10" x2="12" y2="14"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
  info: '<circle cx="12" cy="12" r="9"/><line x1="12" y1="11" x2="12" y2="16.5"/><line x1="12" y1="7.5" x2="12.01" y2="7.5"/>',
  circle: '<circle cx="12" cy="12" r="5" fill="currentColor"/>',
  "chevron-right": '<polyline points="9 6 15 12 9 18"/>',
  "chevron-down": '<polyline points="6 9 12 15 18 9"/>',
  "chevron-up": '<polyline points="6 15 12 9 18 15"/>',
  "chevron-left": '<polyline points="15 6 9 12 15 18"/>',
  play: '<path d="M7 4.8v14.4L19 12z"/>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  minus: '<line x1="5" y1="12" x2="19" y2="12"/>',
  terminal:
    '<rect x="3" y="4" width="18" height="16" rx="2"/><polyline points="7 9 10 12 7 15"/><line x1="12" y1="15" x2="17" y2="15"/>',
  "external-link":
    '<path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/>',
  "locate-fixed":
    '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.5"/><line x1="12" y1="2" x2="12" y2="5"/><line x1="12" y1="19" x2="12" y2="22"/><line x1="2" y1="12" x2="5" y2="12"/><line x1="19" y1="12" x2="22" y2="12"/>',
  clipboard: '<rect x="5" y="4" width="14" height="17" rx="2"/><rect x="9" y="2" width="6" height="4" rx="1"/>',
  copy: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
  "trash-2":
    '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>',
  pencil: '<path d="M4 20l1-4.5L16 4.5a2.1 2.1 0 0 1 3 3L8 18.5z"/><line x1="14" y1="6.5" x2="17.5" y2="10"/>',
  "message-square": '<path d="M4 5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 4z"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  compass: '<circle cx="12" cy="12" r="9"/><path d="M15.5 8.5l-2 5-5 2 2-5z"/>',
  book: '<path d="M12 6.5C10 5 7.5 4.5 4 4.8V19c3.5-.3 6 .2 8 1.8 2-1.6 4.5-2.1 8-1.8V4.8c-3.5-.3-6-.2-8 1.7z"/><line x1="12" y1="6.5" x2="12" y2="20.8"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  "bell-off":
    '<path d="M8.7 3.4A6 6 0 0 1 18 8c0 7 3 9 3 9H8"/><path d="M6 8c0 1.1-.2 2.2-.6 3.2"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/><line x1="3" y1="3" x2="21" y2="21"/>',
  "arrow-up": '<line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/>',
  "arrow-left": '<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>',
  search: '<circle cx="11" cy="11" r="7"/><line x1="16.5" y1="16.5" x2="21" y2="21"/>',
  settings:
    '<path d="M18.73 10.07L21.27 10.45L21.27 13.55L18.73 13.93L18.12 15.39L19.65 17.46L17.46 19.65L15.39 18.12L13.93 18.73L13.55 21.27L10.45 21.27L10.07 18.73L8.61 18.12L6.54 19.65L4.35 17.46L5.88 15.39L5.27 13.93L2.73 13.55L2.73 10.45L5.27 10.07L5.88 8.61L4.35 6.54L6.54 4.35L8.61 5.88L10.07 5.27L10.45 2.73L13.55 2.73L13.93 5.27L15.39 5.88L17.46 4.35L19.65 6.54L18.12 8.61Z"/><circle cx="12" cy="12" r="3"/>',
  puzzle: '<path d="M4 7h4a2.5 2.5 0 1 1 5 0h4v4a2.5 2.5 0 1 1 0 5v3H4z"/>',
  home: '<path d="M3 10.5L12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/>',
  "x-circle":
    '<circle cx="12" cy="12" r="9"/><line x1="9" y1="9" x2="15" y2="15"/><line x1="15" y1="9" x2="9" y2="15"/>',
  "check-circle": '<circle cx="12" cy="12" r="9"/><polyline points="8 12.5 11 15.5 16 9.5"/>',
  layers: '<path d="M12 3L2.5 8 12 13l9.5-5z"/><path d="M2.5 12.5L12 17.5l9.5-5"/><path d="M2.5 17L12 22l9.5-5"/>',
  palette:
    '<path d="M12 3a9 9 0 1 0 0 18c1 0 1.7-.8 1.7-1.7 0-.5-.2-.9-.5-1.2-.3-.3-.4-.7-.4-1.1 0-1 .8-1.8 1.8-1.8H17a4 4 0 0 0 4-4C21 6.6 17 3 12 3z"/><circle cx="8" cy="8.5" r="1"/><circle cx="12" cy="7.5" r="1"/><circle cx="16" cy="9.5" r="1"/>',
  keyboard:
    '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>',
  type: '<polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/>',
  sliders:
    '<line x1="4" y1="6" x2="7" y2="6"/><line x1="11" y1="6" x2="20" y2="6"/><circle cx="9" cy="6" r="2"/><line x1="4" y1="12" x2="13" y2="12"/><line x1="17" y1="12" x2="20" y2="12"/><circle cx="15" cy="12" r="2"/><line x1="4" y1="18" x2="6" y2="18"/><line x1="10" y1="18" x2="20" y2="18"/><circle cx="8" cy="18" r="2"/>',
  layout:
    '<rect x="3" y="4" width="18" height="16" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="9" x2="9" y2="20"/>',
  "panel-left":
    '<rect x="3" y="4" width="18" height="16" rx="2"/><rect x="3" y="4" width="6" height="16" rx="2" fill="currentColor"/>',
  "panel-right":
    '<rect x="3" y="4" width="18" height="16" rx="2"/><rect x="15" y="4" width="6" height="16" rx="2" fill="currentColor"/>',
  "panel-bottom":
    '<rect x="3" y="4" width="18" height="16" rx="2"/><rect x="3" y="14" width="18" height="6" rx="2" fill="currentColor"/>',
  history: '<path d="M3 12a9 9 0 1 0 2.6-6.4"/><polyline points="3 4 3 9 8 9"/><polyline points="12 7 12 12 15 14"/>',
  clock: '<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15.5 14"/>',
  list: '<line x1="9" y1="6" x2="20" y2="6"/><line x1="9" y1="12" x2="20" y2="12"/><line x1="9" y1="18" x2="20" y2="18"/><path d="M4.5 6h.01M4.5 12h.01M4.5 18h.01"/>',
  "more-horizontal": '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  "grip-vertical":
    '<circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/>',
  save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>',
  download:
    '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
  upload:
    '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  star: '<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/>',
  heart: '<path d="M12 20.5S3.5 15.5 3.5 9.2A4.4 4.4 0 0 1 12 7a4.4 4.4 0 0 1 8.5 2.2c0 6.3-8.5 11.3-8.5 11.3z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><line x1="12" y1="2" x2="12" y2="4"/><line x1="12" y1="20" x2="12" y2="22"/><line x1="4.9" y1="4.9" x2="6.3" y2="6.3"/><line x1="17.7" y1="17.7" x2="19.1" y2="19.1"/><line x1="2" y1="12" x2="4" y2="12"/><line x1="20" y1="12" x2="22" y2="12"/><line x1="4.9" y1="19.1" x2="6.3" y2="17.7"/><line x1="17.7" y1="6.3" x2="19.1" y2="4.9"/>',
  moon: '<path d="M20.5 14.5A8.5 8.5 0 1 1 9.5 3.5a7 7 0 0 0 11 11z"/>',
  zap: '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>',
  cpu: '<rect x="5" y="5" width="14" height="14" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/>',
  box: '<path d="M3 7.5L12 3l9 4.5v9L12 21l-9-4.5z"/><path d="M3 7.5l9 4.5 9-4.5"/><line x1="12" y1="12" x2="12" y2="21"/>',
  package:
    '<rect x="2" y="5" width="20" height="4" rx="1"/><path d="M4 9v11h16V9"/><line x1="10" y1="13" x2="14" y2="13"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c-3.5 3-3.5 15 0 18c3.5-3 3.5-15 0-18z"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  "help-circle":
    '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14"/><line x1="12" y1="17.5" x2="12" y2="17.6"/>',
};

ICONS.warning = ICONS["alert-triangle"] as string;

/** Whether an icon of that name exists. */
export function hasIcon(name: string): boolean {
  return Object.hasOwn(ICONS, name);
}

// Not in the JSX type of <svg>, so it is spread in rather than written inline.
const svgDefaults = { focusable: "false" };

/** An inline SVG icon; unknown names draw a small circle. `size` in CSS px or em string, default "1em". Decorative by default (aria-hidden); pass `label` to make it meaningful (role="img" + aria-label). */
export function Icon(props: { name: string; size?: string | number; class?: string; label?: string }): JSX.Element {
  const size = (): string => {
    const s = props.size ?? "1em";
    return typeof s === "number" ? `${s}px` : s;
  };
  return (
    <svg
      class={props.class ? `ot-icon ${props.class}` : "ot-icon"}
      width={size()}
      height={size()}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      role={props.label ? "img" : undefined}
      aria-label={props.label}
      aria-hidden={props.label ? undefined : "true"}
      {...svgDefaults}
      style={{ "vertical-align": "-0.125em", flex: "none" }}
      innerHTML={ICONS[props.name] ?? ICONS.circle}
    />
  );
}
