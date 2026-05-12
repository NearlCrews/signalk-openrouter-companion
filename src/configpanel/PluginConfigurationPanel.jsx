import React, { useState } from 'react';

const S = {
  root: {
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    color: '#333',
    padding: '16px 0',
  },
  banner: {
    padding: '10px 14px',
    background: '#eef2ff',
    color: '#3730a3',
    border: '1px solid #c7d2fe',
    borderRadius: 8,
    fontSize: 13,
    marginBottom: 16,
  },
  pre: {
    background: '#f8f9fa',
    border: '1px solid #e0e0e0',
    borderRadius: 8,
    padding: 14,
    fontSize: 12,
    lineHeight: 1.45,
    overflow: 'auto',
    maxHeight: 360,
  },
  btn: {
    marginTop: 14,
    padding: '8px 16px',
    border: 'none',
    borderRadius: 6,
    fontSize: 13,
    fontWeight: 600,
    background: '#3b82f6',
    color: '#fff',
    cursor: 'pointer',
  },
  status: { marginTop: 10, fontSize: 12, color: '#10b981' },
};

export default function PluginConfigurationPanel({ configuration, save }) {
  const [savedAt, setSavedAt] = useState(null);

  const onSave = () => {
    save(configuration || {});
    setSavedAt(new Date().toLocaleTimeString());
  };

  return (
    <div style={S.root}>
      <div style={S.banner}>
        OpenRouter Companion custom panel scaffold (Session A). The full UI lands in subsequent
        sessions: live status, per-analyzer fire-now, last-report viewer, and prompt editor.
      </div>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
        Current saved configuration
      </div>
      <pre style={S.pre}>{JSON.stringify(configuration ?? {}, null, 2)}</pre>
      <button type="button" style={S.btn} onClick={onSave}>
        Save (no-op rewrite)
      </button>
      {savedAt && <div style={S.status}>Saved at {savedAt}</div>}
    </div>
  );
}
