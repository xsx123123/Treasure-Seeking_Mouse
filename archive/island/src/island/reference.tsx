/** Original welcome components in their ordinary document CSS context; no SPA/auth. */
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { EmptyState } from '../components/chat/EmptyState';
import { Composer } from '../components/chat/Composer';
import { ControlledI18nProvider } from '../i18n/provider';
import '../styles.css';
const query = new URLSearchParams(location.search);
const lang = query.get('lang') === 'en' ? 'en' : 'zh';
document.documentElement.lang = lang;
document.documentElement.classList.toggle('dark', query.get('theme') === 'dark');
const noTyping = () => {};
function Reference() {
  const [draft, setDraft] = useState('');
  const [model, setModel] = useState('平台模型 A');
  return <ControlledI18nProvider lang={lang}>
    <main style={{ minHeight: '100vh' }}><EmptyState submitting={false} onPick={setDraft}
      composer={<Composer models={['平台模型 A', '平台模型 B']} model={model} onModelChange={setModel}
        streaming={false} onSend={() => {}} onStop={() => {}} value={draft} onValueChange={setDraft}
        welcome onTyping={noTyping} />} /></main>
  </ControlledI18nProvider>;
}
createRoot(document.getElementById('root')!).render(<Reference />);
