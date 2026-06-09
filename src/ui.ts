export const POI_PIN_SVG_ORIGIN =
  '<svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true"><path fill="#4caf50" stroke="#2e7d32" stroke-width="1.2" d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3.2" fill="#fff"/></svg>';
export const POI_PIN_SVG_DEST =
  '<svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true"><path fill="#9c27b0" stroke="#6a1b9a" stroke-width="1.2" d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3.2" fill="#fff"/></svg>';

const NAVME_LOGO_SRCS = ['/assets/NavMe_wb.png', './NavMe_wb.png', '/assets/navmelogo.png'];

export function injectMini3dGtaUiStyles(): void {
  if (typeof document === 'undefined' || document.getElementById('mini3dgta-ui-styles')) return;
  const style = document.createElement('style');
  style.id = 'mini3dgta-ui-styles';
  style.textContent = `
.mini3dgta-map-toggle{
  position:fixed;top:max(12px,env(safe-area-inset-top,0px));left:max(12px,env(safe-area-inset-left,0px));
  z-index:2147483001;width:48px;height:48px;padding:0;border:none;border-radius:50%;
  background:#fff;box-shadow:0 4px 16px rgba(0,0,0,.35);cursor:pointer;pointer-events:auto;
  display:flex;align-items:center;justify-content:center;overflow:hidden;
  transition:transform .15s ease,box-shadow .15s ease,opacity .15s ease}
.mini3dgta-map-toggle img{width:100%;height:100%;object-fit:cover;display:block;pointer-events:none}
.mini3dgta-map-toggle:hover{transform:translateY(-1px);box-shadow:0 6px 20px rgba(0,0,0,.4)}
.mini3dgta-map-toggle--hidden{display:none!important}
.mini3dgta-fs-overlay{
  position:fixed;inset:0;z-index:2147483000;display:none;flex-direction:column;
  background:#f5f5f5;pointer-events:auto;font-family:system-ui,-apple-system,Segoe UI,sans-serif}
.mini3dgta-fs-toolbar{
  display:grid;grid-template-columns:1fr 1fr minmax(88px,auto) auto;gap:10px 12px;align-items:end;
  padding:max(12px,env(safe-area-inset-top,0px)) 14px 12px;
  background:#ffffff;border-bottom:1px solid #e0e0e0;flex-shrink:0;
  box-shadow:0 2px 12px rgba(0,0,0,.06)}
.mini3dgta-fs-toolbar--with-map{
  grid-template-columns:minmax(100px,1fr) 1fr 1fr minmax(88px,auto) auto;
  grid-template-rows:auto auto}
.mini3dgta-fs-field--project{grid-column:1;grid-row:2}
.mini3dgta-fs-field--map{grid-column:2/span 2;grid-row:2}
.mini3dgta-fs-refresh{
  grid-column:4;grid-row:2;align-self:end;
  padding:10px 14px;border:none;border-radius:10px;cursor:pointer;
  background:#9c27b0;color:#fff;font-size:13px;font-weight:600;line-height:1;white-space:nowrap}
.mini3dgta-fs-refresh:hover{background:#7b1fa2}
.mini3dgta-fs-refresh:disabled{opacity:.55;cursor:not-allowed}
.mini3dgta-fs-input{
  width:100%;box-sizing:border-box;padding:10px 11px;border-radius:10px;
  border:1px solid #cccccc;background-color:#ffffff;
  color:#424242;font-size:14px;font-weight:500}
.mini3dgta-fs-input:focus{outline:none;border-color:#9c27b0;box-shadow:0 0 0 2px rgba(156,39,176,.22)}
.mini3dgta-fs-input--map{text-transform:uppercase;letter-spacing:.04em}
.mini3dgta-fs-field{display:flex;flex-direction:column;gap:5px;min-width:0}
.mini3dgta-fs-field__label{display:flex;align-items:center;gap:6px;font-size:10px;font-weight:700;
  letter-spacing:.08em;text-transform:uppercase;color:#757575}
.mini3dgta-fs-field__label svg{width:13px;height:13px;flex-shrink:0}
.mini3dgta-fs-field__label--origin svg{fill:#4caf50;stroke:#2e7d32;stroke-width:.8}
.mini3dgta-fs-field__label--dest svg{fill:#9c27b0;stroke:#6a1b9a;stroke-width:.8}
.mini3dgta-fs-select{
  width:100%;box-sizing:border-box;padding:10px 34px 10px 11px;border-radius:10px;
  border:1px solid #cccccc;background-color:#ffffff;
  background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23757575' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E");
  background-repeat:no-repeat;background-position:right 11px center;
  color:#424242;font-size:14px;font-weight:500;cursor:pointer;appearance:none;-webkit-appearance:none}
.mini3dgta-fs-select:focus{outline:none}
.mini3dgta-fs-select--origin:focus{border-color:#4caf50;box-shadow:0 0 0 2px rgba(76,175,80,.25)}
.mini3dgta-fs-select--dest:focus{border-color:#9c27b0;box-shadow:0 0 0 2px rgba(156,39,176,.22)}
.mini3dgta-fs-select--project:focus{border-color:#9c27b0;box-shadow:0 0 0 2px rgba(156,39,176,.22)}
.mini3dgta-fs-close{
  align-self:end;padding:10px 14px;min-width:44px;border:none;border-radius:10px;
  background:#e0e0e0;color:#424242;font-size:17px;font-weight:600;cursor:pointer;line-height:1}
.mini3dgta-fs-close:hover{background:#d0d0d0}
.mini3dgta-fs-tools{
  display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:8px 14px;
  background:#ffffff;border-bottom:1px solid #e0e0e0;flex-shrink:0}
.mini3dgta-fs-analyze,.mini3dgta-fs-tool,.mini3dgta-fs-save{
  padding:8px 14px;border:none;border-radius:8px;cursor:pointer;
  font-size:12px;font-weight:600;line-height:1;white-space:nowrap;color:#616161;
  background:#f0f0f0}
.mini3dgta-fs-analyze:hover,.mini3dgta-fs-tool:hover:not(:disabled){background:#e0e0e0}
.mini3dgta-fs-analyze:disabled,.mini3dgta-fs-tool:disabled{opacity:.45;cursor:not-allowed;color:#9e9e9e}
.mini3dgta-fs-tool--active{background:#9c27b0;color:#fff}
.mini3dgta-fs-tool--active:hover{background:#7b1fa2}
.mini3dgta-fs-save{background:#4caf50;color:#fff}
.mini3dgta-fs-save:hover:not(:disabled){background:#43a047}
.mini3dgta-fs-save:disabled{opacity:.45;cursor:not-allowed;background:#e0e0e0;color:#9e9e9e}
.mini3dgta-fs-shapes{
  display:inline-flex;gap:4px;align-items:center;padding:2px 4px;
  border-radius:8px;background:#f5f5f5;border:1px solid #e0e0e0}
.mini3dgta-fs-shape{
  padding:6px 10px;border:none;border-radius:6px;cursor:pointer;
  font-size:11px;font-weight:600;color:#616161;background:transparent}
.mini3dgta-fs-shape:hover{background:#e8e8e8}
.mini3dgta-fs-shape--active{background:#9c27b0;color:#fff}
.mini3dgta-fs-shape--active:hover{background:#7b1fa2}
.floor2d-layout{display:flex;flex:1;min-height:0;min-width:0;width:100%}
.floor2d-zone-sidebar{
  width:220px;flex-shrink:0;display:flex;flex-direction:column;
  background:#fff;border-right:1px solid #e0e0e0;overflow:hidden}
.floor2d-zone-sidebar__header{
  padding:12px 14px 6px;font-size:12px;font-weight:700;letter-spacing:.04em;
  text-transform:uppercase;color:#616161}
.floor2d-zone-sidebar__hint{
  padding:0 14px 10px;font-size:11px;line-height:1.35;color:#9e9e9e}
.floor2d-zone-list{flex:1;overflow-y:auto;padding:6px 8px 12px}
.floor2d-zone-list__empty{padding:10px 8px;font-size:12px;color:#9e9e9e;line-height:1.4}
.floor2d-zone-item{
  display:flex;align-items:center;gap:8px;width:100%;padding:8px 10px;margin-bottom:4px;
  border:1px solid transparent;border-radius:8px;background:#f8f8f8;cursor:pointer;text-align:left}
.floor2d-zone-item:hover{background:#f0f0f0;border-color:#e0e0e0}
.floor2d-zone-item--active{background:#f3e5f5;border-color:#ce93d8}
.floor2d-zone-item__dot{width:10px;height:10px;border-radius:50%;flex-shrink:0}
.floor2d-zone-item__name{
  font-size:12px;font-weight:600;color:#424242;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mini3dgta-fs-map{position:relative;flex:1;min-height:0;min-width:0;overflow:hidden}
.floor2d-zone-dialog{
  position:absolute;inset:0;z-index:30;display:flex;align-items:center;justify-content:center;
  background:rgba(0,0,0,.35);pointer-events:auto}
.floor2d-zone-dialog__panel{
  width:min(320px,calc(100% - 32px));padding:16px;border-radius:12px;background:#fff;
  box-shadow:0 8px 32px rgba(0,0,0,.2);border:1px solid #e0e0e0}
.floor2d-zone-dialog__title{font-size:14px;font-weight:700;color:#424242;margin-bottom:10px}
.floor2d-zone-dialog__input{
  width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #e0e0e0;border-radius:8px;
  font-size:14px;color:#424242;outline:none;margin-bottom:12px}
.floor2d-zone-dialog__input:focus{border-color:#9c27b0;box-shadow:0 0 0 2px rgba(156,39,176,.22)}
.floor2d-zone-dialog__actions{display:flex;gap:8px;justify-content:flex-end}
.floor2d-zone-dialog__btn{
  padding:8px 14px;border:none;border-radius:8px;cursor:pointer;font-size:12px;font-weight:600}
.floor2d-zone-dialog__btn--cancel{background:#f0f0f0;color:#616161}
.floor2d-zone-dialog__btn--cancel:hover{background:#e0e0e0}
.floor2d-zone-dialog__btn--ok{background:#9c27b0;color:#fff}
.floor2d-zone-dialog__btn--ok:hover{background:#7b1fa2}
.mini3dgta-map-overlay{position:absolute;inset:0;pointer-events:none;overflow:hidden;z-index:4}
.mini3dgta-poi-label{
  position:absolute;transform:translate(4px,-50%);max-width:120px;text-align:left;
  font:600 11px/1.15 system-ui,sans-serif;color:#9c27b0;letter-spacing:.01em;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none}
.mini3dgta-route-pin{
  position:absolute;transform:translate(-50%,-100%);pointer-events:none;
  filter:drop-shadow(0 2px 5px rgba(0,0,0,.5))}
.mini3dgta-route-pin svg{width:34px;height:34px;display:block}
.mini3dgta-route-pin--hidden{display:none}
@media (max-width:520px){
  .mini3dgta-fs-toolbar{grid-template-columns:1fr auto}
  .mini3dgta-fs-field--dest{grid-column:1}
  .mini3dgta-fs-field--slice{display:none!important}
  .mini3dgta-fs-field--map{grid-column:1;grid-row:2}
  .mini3dgta-fs-refresh{grid-column:2;grid-row:2}
  .mini3dgta-fs-close{grid-column:2;grid-row:1;align-self:center}
}
`;
  document.head.appendChild(style);
}

export function applyNavMeLogoToToggleButton(btn: HTMLButtonElement): void {
  btn.textContent = '';
  btn.setAttribute('aria-label', 'Open navigation map');
  const img = document.createElement('img');
  img.alt = '';
  img.draggable = false;
  let srcIdx = 0;
  img.onerror = () => {
    srcIdx += 1;
    if (srcIdx < NAVME_LOGO_SRCS.length) {
      img.src = NAVME_LOGO_SRCS[srcIdx];
      return;
    }
    img.remove();
    btn.innerHTML =
      '<svg viewBox="0 0 32 32" width="32" height="32" aria-hidden="true"><circle cx="16" cy="16" r="15" fill="#2E6DAD"/><path fill="#fff" d="M10 22V10h3.2l4.8 7.4L22.8 10H26v12h-2.8v-7.1L17.6 22h-2.1l-5.6-7.1V22H10z"/></svg>';
  };
  img.src = NAVME_LOGO_SRCS[0];
  btn.appendChild(img);
}

export function createMini3dGtaMapButton(onOpen: () => void): HTMLButtonElement {
  injectMini3dGtaUiStyles();
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'mini3dgta-map-toggle';
  applyNavMeLogoToToggleButton(btn);
  btn.addEventListener('click', onOpen);
  document.body.appendChild(btn);
  return btn;
}
