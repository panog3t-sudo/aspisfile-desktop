// Signature requests (stage 2, 2026-10-21) — OWNER placement panel. Shown while
// the owner is placing fields on their own document: click the page to add a
// box, assign each to a recipient (or anyone), save. Saved fields are listed
// with their signed state and can be deleted.
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif";
const MONO = "ui-monospace,Menlo,monospace";

export type SavedField = { id: string; page: number; recipient_email?: string | null; signed: boolean; signed_by?: string[] };
export type DraftField = { tempId: string; page: number; recipient_id: string | null };
export type PanelRecipient = { id: string; email: string; outstanding?: number; requested_at?: string | null };

export function SignatureFieldsPanel({ saved, drafts, recipients, saving, requesting, onRequest, onAssign, onRemoveDraft, onDeleteSaved, onSave, onClose }: {
  saved: SavedField[]; drafts: DraftField[]; recipients: PanelRecipient[]; saving: boolean;
  requesting?: boolean; onRequest?: () => void;
  onAssign: (tempId: string, recipientId: string | null) => void; onRemoveDraft: (tempId: string) => void;
  onDeleteSaved: (id: string) => void; onSave: () => void; onClose: () => void;
}) {
  const row: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, padding: '7px 0', borderTop: '1px solid #2E3760', fontSize: 12.5 };
  const sel: React.CSSProperties = { flex: 1, minWidth: 0, background: '#080A14', color: '#EAEFFB', border: '1px solid #2E3760', borderRadius: 7, padding: '5px 7px', fontSize: 12, fontFamily: FONT };
  const x: React.CSSProperties = { background: 'none', border: 'none', color: '#9098BC', cursor: 'pointer', fontSize: 15, lineHeight: 1, padding: '0 2px' };
  return (
    <div style={{ position: 'fixed', right: 16, bottom: 18, width: 340, maxHeight: '70vh', overflowY: 'auto', zIndex: 998, background: '#141830', border: '1px solid #2E3760', borderRadius: 14, padding: '14px 14px 12px', boxShadow: '0 16px 40px rgba(0,0,0,.55)', fontFamily: FONT, color: '#EAEFFB' }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 6 }}>
        <span style={{ fontSize: 13.5, fontWeight: 660 }}>Signature fields</span>
        <button onClick={onClose} style={{ ...x, marginLeft: 'auto' }}>×</button>
      </div>
      <div style={{ background: '#1A2038', border: '1px solid #26305A', borderRadius: 9, padding: '8px 10px', fontSize: 11.5, lineHeight: 1.45, color: '#C9D2F0', margin: '6px 0 8px' }}>
        <b style={{ color: '#fff' }}>Where should people sign?</b>
        <ol style={{ margin: '4px 0 0', paddingLeft: 16 }}>
          <li>Click the page once for each signature box.</li>
          <li>Drag a box to move it, drag its corner to resize. Boxes keep a signature&rsquo;s shape.</li>
          <li>Pick who signs each box, or leave it for anyone.</li>
          <li>Press <b style={{ color: '#fff' }}>Save</b>. Nobody is notified until you request the signatures.</li>
        </ol>
      </div>
      {saved.length > 0 && (
        <div style={{ marginTop: 4 }}>
          <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.08em', textTransform: 'uppercase', color: '#666E96', margin: '6px 0 2px' }}>Placed</div>
          {saved.map(f => (
            <div key={f.id} style={row}>
              <span style={{ fontFamily: MONO, fontSize: 10.5, color: '#7C9CF5' }}>p.{f.page}</span>
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.recipient_email ?? 'Anyone'}</span>
              <span style={{ fontFamily: MONO, fontSize: 10, color: f.signed ? '#4ADE80' : '#F4BF4F' }}>{f.signed ? 'SIGNED' : 'WAITING'}</span>
              {!f.signed && <button onClick={() => onDeleteSaved(f.id)} title="Remove this field" style={x}>×</button>}
            </div>
          ))}
        </div>
      )}
      {drafts.length > 0 && (
        <div style={{ marginTop: 4 }}>
          <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.08em', textTransform: 'uppercase', color: '#666E96', margin: '6px 0 2px' }}>New · not saved</div>
          {drafts.map(d => (
            <div key={d.tempId} style={row}>
              <span style={{ fontFamily: MONO, fontSize: 10.5, color: '#E0A54B' }}>p.{d.page}</span>
              <select value={d.recipient_id ?? ''} onChange={e => onAssign(d.tempId, e.target.value || null)} style={sel}>
                <option value="">Anyone</option>
                {recipients.map(r => <option key={r.id} value={r.id}>{r.email}</option>)}
              </select>
              <button onClick={() => onRemoveDraft(d.tempId)} title="Remove" style={x}>×</button>
            </div>
          ))}
        </div>
      )}
      {(() => {
        const waiting = recipients.filter(r => (r.outstanding ?? 0) > 0);
        if (!onRequest || drafts.length || !saved.length || !waiting.length) return null;
        return (
          <div style={{ marginTop: 10 }}>
            <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.08em', textTransform: 'uppercase', color: '#666E96', margin: '6px 0 4px' }}>To ask</div>
            {waiting.map(r => (
              <div key={r.id} style={row}>
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.email}</span>
                <span style={{ fontFamily: MONO, fontSize: 10, color: r.requested_at ? '#7C9CF5' : '#F4BF4F' }}>{r.requested_at ? 'ASKED' : `${r.outstanding} TO SIGN`}</span>
              </div>
            ))}
            <button onClick={onRequest} disabled={requesting}
              style={{ width: '100%', marginTop: 8, background: '#B7791F', color: '#fff', border: 'none', borderRadius: 10, padding: 10, fontSize: 13, fontWeight: 660, cursor: requesting ? 'default' : 'pointer' }}>
              {requesting ? 'Sending…' : `Request signatures from ${waiting.length === 1 ? '1 person' : `${waiting.length} people`}`}
            </button>
          </div>
        );
      })()}
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button onClick={onSave} disabled={!drafts.length || saving}
          style={{ flex: 1, background: drafts.length ? '#2E55D4' : '#26305A', color: '#fff', border: 'none', borderRadius: 10, padding: 10, fontSize: 13, fontWeight: 660, cursor: drafts.length ? 'pointer' : 'default' }}>
          {saving ? 'Saving…' : `Save ${drafts.length || ''} field${drafts.length === 1 ? '' : 's'}`}
        </button>
        <button onClick={onClose} style={{ padding: '10px 14px', borderRadius: 10, border: '1px solid #2E3760', background: 'transparent', color: '#EAEFFB', fontSize: 13, cursor: 'pointer' }}>Done</button>
      </div>
      <div style={{ fontFamily: MONO, fontSize: 10.5, color: '#666E96', marginTop: 9, textAlign: 'center' }}>Each person gets an email with a link to sign. Reminders live on the file&rsquo;s page in your dashboard.</div>
    </div>
  );
}
