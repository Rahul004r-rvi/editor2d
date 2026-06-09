import { mountMini3dGta } from './mountMini3dGta';
import { FLOOR_SLICE_Y } from './config';

mountMini3dGta(document.body, {
  viewMode: '2d',
  floorSliceY: FLOOR_SLICE_Y,
  autoStartFullscreen: true,
  deferLoadUntilMapOpen: false,
  suppressMapToggle: true,
  updateDocumentTitle: true,
});
