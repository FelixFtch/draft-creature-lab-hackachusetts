import { createRoot } from 'react-dom/client';
import App from './App.jsx';

const start = () => createRoot(document.getElementById('root')).render(<App />);
// The backend-free web demo (`vite build --mode demo`) answers service calls from
// static snapshots; this branch is dropped from the normal build.
if (import.meta.env.MODE === 'demo') import('./demo/shim.js').then(({ installDemo }) => { installDemo(); start(); });
else start();
