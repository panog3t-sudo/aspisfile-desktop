// Signature requests (stage 2, 2026-10-21) — OWNER placement panel. Shown while
// the owner is placing fields on their own document: click the page to add a
// box, assign each to a recipient (or anyone), save. Saved fields are listed
// with their signed state and can be deleted.
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif";
const MONO = "ui-monospace,Menlo,monospace";

export type SavedField = { id: string; page: number; recipient_email?: string | null; signed: boolean; signed_by?: string[] };
export type DraftField = { tempId: string; page: number; recipient_id: string | null };

export function SignatureFieldsPanel({ saved, drafts, recipients, saving, onAssign, onRemoveDraft, onDeleteSaved, onSave, onClose }: {
  saved: SavedField[]; drafts: DraftField[]; recipients: Array<{ id: string; email: string }>; saving: boolean;
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
      <div style={{ fontSize: 11.5, color: '#9098BC', marginBottom: 8 }}>Click on the page where a recipient should sign. Drag a box to move it, drag its corner to resize.</div>
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
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button onClick={onSave} disabled={!drafts.length || saving}
          style={{ flex: 1, background: drafts.length ? '#2E55D4' : '#26305A', color: '#fff', border: 'none', borderRadius: 10, padding: 10, fontSize: 13, fontWeight: 660, cursor: drafts.length ? 'pointer' : 'default' }}>
          {saving ? 'Saving…' : `Save ${drafts.length || ''} field${drafts.length === 1 ? '' : 's'}`}
        </button>
        <button onClick={onClose} style={{ padding: '10px 14px', borderRadius: 10, border: '1px solid #2E3760', background: 'transparent', color: '#EAEFFB', fontSize: 13, cursor: 'pointer' }}>Done</button>
      </div>
      <div style={{ fontFamily: MONO, fontSize: 10.5, color: '#666E96', marginTop: 9, textAlign: 'center' }}>Recipients are asked to sign from your dashboard.</div>
    </div>
  );
}
