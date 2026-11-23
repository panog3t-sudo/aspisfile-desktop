// Signature requests (stage 2, 2026-10-21) — OWNER placement panel. Shown while
// the owner is placing fields on their own document: click the page to add a
// box, assign each to a recipient (or anyone), save. Saved fields are listed
// with their signed state and can be deleted.
import { FloatingPanel } from '../components/FloatingPanel';
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif";
const MONO = "ui-monospace,Menlo,monospace";

export type SavedField = { id: string; page: number; recipient_email?: string | null; signed: boolean; signed_by?: string[]; signer_kind?: 'recipient' | 'owner' };
export type DraftField = { tempId: string; page: number; recipient_id: string | null; signer_kind?: 'recipient' | 'owner' };
/** The assignee value that means "me — I will countersign" (Release A). */
export const OWNER_ASSIGNEE = '__owner__';
export type PanelRecipient = { id: string; email: string; outstanding?: number; requested_at?: string | null };

export function SignatureFieldsPanel({ saved, drafts, recipients, saving, requesting, onRequest, onAssign, onRemoveDraft, onDeleteSaved, onSave, onClose, countersign, setCountersign, completionEnabled, releaseExecutedCopy, setReleaseExecutedCopy }: {
  saved: SavedField[]; drafts: DraftField[]; recipients: PanelRecipient[]; saving: boolean;
  requesting?: boolean; onRequest?: () => void;
  onAssign: (tempId: string, recipientId: string | null) => void; onRemoveDraft: (tempId: string) => void;
  onDeleteSaved: (id: string) => void; onSave: () => void; onClose: () => void;
  // Signature completion (Release A): "I will countersign" — default ON when
  // the server offers completion. While on, Save waits for a box assigned to Me.
  countersign?: boolean; setCountersign?: (b: boolean) => void; completionEnabled?: boolean;
  // Release B: "Parties may download the executed copy when everyone has signed" — the sender's decision, default on.
  releaseExecutedCopy?: boolean; setReleaseExecutedCopy?: (b: boolean) => void;
}) {
  const ownerBoxes = saved.filter(f => f.signer_kind === 'owner').length + drafts.filter(d => d.recipient_id === OWNER_ASSIGNEE).length;
  const needsOwnerBox = !!completionEnabled && !!countersign && ownerBoxes === 0;
  const row: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, padding: '7px 0', borderTop: '1px solid #2E3760', fontSize: 12.5 };
  const sel: React.CSSProperties = { flex: 1, minWidth: 0, background: '#080A14', color: '#EAEFFB', border: '1px solid #2E3760', borderRadius: 7, padding: '5px 7px', fontSize: 12, fontFamily: FONT };
  const x: React.CSSProperties = { background: 'none', border: 'none', color: '#9098BC', cursor: 'pointer', fontSize: 15, lineHeight: 1, padding: '0 2px' };
  return (
    <FloatingPanel title="Signature fields" pill={`Signature fields${drafts.length ? ` · ${drafts.length} unsaved` : saved.length ? ` · ${saved.length} placed` : ''}`} corner="bottom-right" onClose={onClose}>
      <div style={{ background: '#1A2038', border: '1px solid #26305A', borderRadius: 9, padding: '8px 10px', fontSize: 11.5, lineHeight: 1.45, color: '#C9D2F0', margin: '6px 0 8px' }}>
        <b style={{ color: '#fff' }}>Where should people sign?</b>
        <ol style={{ margin: '4px 0 0', paddingLeft: 16 }}>
          <li>Click the page once for each signature box.</li>
          <li>Drag a box to move it, drag its corner to resize. Boxes keep a signature&rsquo;s shape.</li>
          <li>Pick who signs each box, or leave it for anyone.{completionEnabled ? ' Pick Me for the box you will countersign.' : ''}</li>
          <li>Press <b style={{ color: '#fff' }}>Save</b>. Nobody is notified until you request the signatures.</li>
        </ol>
      </div>
      {completionEnabled && setCountersign && (
        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 9, fontSize: 12.5, color: '#EAEFFB', margin: '2px 0 8px', cursor: 'pointer' }}>
          <input type="checkbox" checked={!!countersign} onChange={e => setCountersign(e.target.checked)} style={{ marginTop: 2 }} />
          <span><b>I will countersign</b> — I sign last, after everyone else. When all parties have signed, the document is completed and locked and every party receives the certificate.
            {needsOwnerBox && <span style={{ display: 'block', color: '#F4BF4F', marginTop: 3 }}>Click the page for your own box and pick <b>Me</b>.</span>}
          </span>
        </label>
      )}
      {completionEnabled && setReleaseExecutedCopy && releaseExecutedCopy !== undefined && (
        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 9, fontSize: 12.5, color: '#EAEFFB', margin: '0 0 8px', cursor: 'pointer' }}>
          <input type="checkbox" checked={!!releaseExecutedCopy} onChange={e => setReleaseExecutedCopy(e.target.checked)} style={{ marginTop: 2 }} />
          <span><b>Parties may download the executed copy when everyone has signed</b> — <span style={{ color: '#9DB4FF' }}>A released copy is the party&rsquo;s own and is not recalled by revoke.</span></span>
        </label>
      )}
      {saved.length > 0 && (
        <div style={{ marginTop: 4 }}>
          <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.08em', textTransform: 'uppercase', color: '#666E96', margin: '6px 0 2px' }}>Placed</div>
          {saved.map(f => (
            <div key={f.id} style={row}>
              <span style={{ fontFamily: MONO, fontSize: 10.5, color: '#7C9CF5' }}>p.{f.page}</span>
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.signer_kind === 'owner' ? 'Me — countersign (signs last)' : (f.recipient_email ?? 'Anyone')}</span>
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
                {completionEnabled && <option value={OWNER_ASSIGNEE}>Me — countersign (signs last)</option>}
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
        <button onClick={onSave} disabled={!drafts.length || saving || needsOwnerBox} title={needsOwnerBox ? 'Add a box for your own signature, or untick "I will countersign"' : undefined}
          style={{ flex: 1, background: drafts.length && !needsOwnerBox ? '#2E55D4' : '#26305A', color: '#fff', border: 'none', borderRadius: 10, padding: 10, fontSize: 13, fontWeight: 660, cursor: drafts.length && !needsOwnerBox ? 'pointer' : 'default' }}>
          {saving ? 'Saving…' : `Save ${drafts.length || ''} field${drafts.length === 1 ? '' : 's'}`}
        </button>
        <button onClick={onClose} style={{ padding: '10px 14px', borderRadius: 10, border: '1px solid #2E3760', background: 'transparent', color: '#EAEFFB', fontSize: 13, cursor: 'pointer' }}>Done</button>
      </div>
      <div style={{ fontFamily: MONO, fontSize: 10.5, color: '#666E96', marginTop: 9, textAlign: 'center' }}>Each person gets an email with a link to sign. Reminders live on the file&rsquo;s page in your dashboard.</div>
    </FloatingPanel>
  );
}
