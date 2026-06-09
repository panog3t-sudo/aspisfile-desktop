// Sprint 8 Phase 2b — render the controller's cursor on top of the
// tile area when the presenter has handed pointer_control to a
// recipient. Position is computed from the rendered image's
// bounding box at render time so it always lands at the same
// RELATIVE point the controller saw on their viewer, regardless of
// the presenter's own zoom/scroll.
//
// Renders nothing when the cursor's page doesn't match the
// presenter's currently-rendered page (e.g. mid-flight before the
// controller_page_change broadcast lands).

import { useEffect, useState } from 'react';

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif";

interface Props {
  email:        string;
  page:         number;
  xRatio:       number;
  yRatio:       number;
  currentPage:  number;
  // Selector for the rendered tile image; we read its bounding box
  // on every render of this component so position tracks the page
  // even if the presenter zoomed/scrolled their own viewport.
  imageSelector?: string;
}

export function ControllerCursor({
  email, page, xRatio, yRatio, currentPage, imageSelector = '[data-cursor-target="tile"]',
}: Props) {
  const [rect, setRect] = useState<{ left: number; top: number; width: number; height: number } | null>(null);

  useEffect(() => {
    function measure() {
      const el = document.querySelector(imageSelector) as HTMLElement | null;
      if (!el) { setRect(null); return; }
      const r = el.getBoundingClientRect();
      setRect({ left: r.left, top: r.top, width: r.width, height: r.height });
    }
    measure();
    // The image position shifts on zoom/scroll/resize. Re-measure
    // on those events so the overlay stays glued to the right spot.
    const opts: AddEventListenerOptions = { passive: true };
    window.addEventListener('scroll', measure, opts);
    window.addEventListener('resize', measure, opts);
    const ro = new ResizeObserver(measure);
    const el = document.querySelector(imageSelector) as HTMLElement | null;
    if (el) ro.observe(el);
    return () => {
      window.removeEventListener('scroll', measure);
      window.removeEventListener('resize', measure);
      ro.disconnect();
    };
  // The page/cursor coords don't affect WHERE the image lives, but
  // we still want a re-measure when the page changes since the
  // image element is re-rendered.
  }, [imageSelector, currentPage]);

  if (page !== currentPage) return null;
  if (!rect || rect.width <= 0 || rect.height <= 0) return null;

  const x = rect.left + xRatio * rect.width;
  const y = rect.top  + yRatio * rect.height;
  const color = colorFromEmail(email);

  return (
    <div
      style={{
        position:      'fixed',
        left:          x,
        top:           y,
        pointerEvents: 'none',
        zIndex:        58,
        transition:    'left 50ms linear, top 50ms linear',
        fontFamily:    FONT,
      }}
    >
      {/* Arrow pointer */}
      <svg width="20" height="22" viewBox="0 0 20 22" style={{ display: 'block', filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.45))' }}>
        <path d="M2 2 L2 17 L7 13 L10 19 L12 18 L9 12 L15 12 Z" fill={color} stroke="#0F172A" strokeWidth="1.2" strokeLinejoin="round" />
      </svg>
      {/* Email label */}
      <div style={{
        marginLeft: 14, marginTop: -4,
        background: color, color: '#FFFFFF',
        padding: '2px 7px', borderRadius: 4,
        fontSize: 10, fontWeight: 500,
        whiteSpace: 'nowrap',
        boxShadow: '0 1px 3px rgba(0,0,0,0.45)',
      }}>
        {email}
      </div>
    </div>
  );
}

// Same hash → HSL helper as PresenterParticipantPanel.colorFromEmail,
// so the cursor colour matches the avatar in the participant panel.
function colorFromEmail(email: string): string {
  let h = 0;
  for (let i = 0; i < email.length; i++) {
    h = (h << 5) - h + email.charCodeAt(i);
    h |= 0;
  }
  return `hsl(${Math.abs(h) % 360}, 65%, 55%)`;
}
