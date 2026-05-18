'use client';

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif";

interface SessionEndedScreenProps {
  presenterName?: string;
  onClose?:       () => void;
}

export function SessionEndedScreen({ presenterName, onClose }: SessionEndedScreenProps) {
  return (
    <div style={{
      position:       'fixed',
      inset:          0,
      background:     '#0F172A',
      zIndex:         100,
      display:        'flex',
      alignItems:     'center',
      justifyContent: 'center',
      flexDirection:  'column',
      fontFamily:     FONT,
      gap:            12,
    }}>
      <div style={{
        width:           48,
        height:          48,
        borderRadius:    '50%',
        background:      'rgba(59,130,246,0.12)',
        display:         'flex',
        alignItems:      'center',
        justifyContent:  'center',
        marginBottom:    8,
      }}>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#93C5FD" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 11l19-9-9 19-2-8-8-2z"/>
        </svg>
      </div>

      <p style={{ fontSize: 16, fontWeight: 500, color: '#FFFFFF', margin: 0 }}>
        Presentation ended
      </p>

      <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.5)', margin: 0, textAlign: 'center', lineHeight: 1.6 }}>
        {presenterName ? `${presenterName} has ended the session.` : 'The presenter has ended the session.'}
        {' '}Your access to this document remains unchanged.
      </p>

      {onClose && (
        <button
          onClick={onClose}
          style={{
            marginTop:    8,
            padding:      '8px 20px',
            borderRadius: 6,
            background:   'rgba(59,130,246,0.15)',
            border:       '0.5px solid rgba(59,130,246,0.35)',
            color:        '#93C5FD',
            fontSize:     12,
            cursor:       'pointer',
            fontFamily:   FONT,
          }}
        >
          Continue viewing
        </button>
      )}
    </div>
  );
}
