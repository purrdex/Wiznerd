export default function CreateScreen() {
  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 32,
      fontFamily: 'system-ui, sans-serif',
      background: '#0a0b0f',
      color: '#e2e8f0',
    }}>
      <div style={{ fontSize: 48, marginBottom: 16 }}>🎨</div>
      <h2 style={{ margin: '0 0 12px', fontSize: 28, fontWeight: 700, color: '#fff' }}>
        Generative Art Studio
      </h2>
      <p style={{ margin: 0, color: '#94a3b8', textAlign: 'center', maxWidth: 400, lineHeight: 1.6 }}>
        Coming soon — upload trait layers, configure rarity weights, and generate your collection.
      </p>
    </div>
  );
}
