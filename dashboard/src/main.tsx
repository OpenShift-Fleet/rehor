import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@patternfly/patternfly/patternfly.css';
import '@patternfly/patternfly/patternfly-addons.css';
import App from './App';
import './App.css';

document.documentElement.classList.add('pf-v6-theme-dark');
document.documentElement.setAttribute('data-theme', 'dark');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
