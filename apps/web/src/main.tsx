import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';
import { consumeSecretLink } from './lib/identity';

const root = document.getElementById('root');
if (!root) throw new Error('Elemento de montagem em falta.');
// Consume URL secrets once, before StrictMode can render the tree twice.
const initialLink = consumeSecretLink();
createRoot(root).render(
  <StrictMode>
    <App initialLink={initialLink} />
  </StrictMode>,
);
