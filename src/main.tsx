// declare module '*.css' {
//   const content: Record<string, string>;
//   export default content;
// }

import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
// @ts-ignore - CSS side-effect imports are handled by the bundler, not by TS declarations in this file.
import './index.css';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
