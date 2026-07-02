// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

import { createRoot } from 'react-dom/client';
import { App } from './App';
import { prefsStore } from './prefs';
import './styles/index.css';

// Apply persisted prefs + any OpenMasjidOS appearance hand-off before first render.
prefsStore.hydrate();

createRoot(document.getElementById('root')!).render(<App />);
