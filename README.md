# Workout Tracker PWA

A Progressive Web App (PWA) conversion of the iOS Workout Tracker app. Works offline, installable on mobile and desktop, no backend required.

## Features

- **Weekly plan view** — see all 4 workout days (Mon/Wed/Thu/Fri) with live progress bars
- **Check off workouts** — tap to mark complete; progress saves automatically
- **Day detail view** — view exercises, category badges, notes, and YouTube video links
- **Add custom workouts** — add your own exercises to any day (saved locally)
- **Delete custom workouts** — swipe or tap trash icon (sheet workouts are read-only)
- **Reset progress** — per day, or reset everything at once
- **Dark / Light mode** — follows system preference, toggleable in the header
- **Offline support** — last-fetched workout data cached for offline use
- **Installable** — add to home screen on iOS/Android or install from Chrome/Edge

## Data Source

Workout data is fetched from a Google Sheet via [gsx2json.com](https://gsx2json.com). The sheet must have columns:

| Day | Workout | Category | Link to Video | Notes |

Custom workouts and completion status are stored in `localStorage` — no account or backend needed.

---

## Deployment to GitHub Pages

### Option A — Root of `main` branch (simplest)

1. Create a new GitHub repository (e.g. `Workout-Tracker`)
2. Push the contents of this folder to the root of `main`:
   ```bash
   git init
   git add .
   git commit -m "Initial PWA commit"
   git remote add origin https://github.com/YOUR_USERNAME/Workout-Tracker.git
   git push -u origin main
   ```
3. Go to **Settings → Pages**, set Source to `main` branch, `/` (root)
4. Your app will be live at `https://YOUR_USERNAME.github.io/Workout-Tracker/`

### Option B — `gh-pages` branch

```bash
git checkout -b gh-pages
git push origin gh-pages
```
Then set GitHub Pages source to the `gh-pages` branch.

### Option C — `/docs` folder

Move all files into a `docs/` folder, push to `main`, and set GitHub Pages source to `main / docs`.

---

## Local Development

No build tools required. Just open `index.html` in a browser, or use a local server:

```bash
# Python
python -m http.server 8080

# Node
npx serve .
```

Then open `http://localhost:8080`.

> **Note:** The service worker requires HTTPS (or `localhost`) to activate. On a plain `file://` URL, the SW is skipped but the app still works.

---

## Icons

The current icon (`icons/icon-1024.png`) is the original iOS app icon at 1024×1024.

For best results, generate properly-sized variants:
- **192×192** — Android home screen
- **512×512** — PWA splash screen
- **180×180** — iOS apple-touch-icon

You can use [Squoosh](https://squoosh.app) or [RealFaviconGenerator](https://realfavicongenerator.net) to resize and generate all variants, then update `manifest.json` accordingly.

---

## File Structure

```
├── index.html       # App shell
├── app.css          # All styles (CSS variables, dark mode, mobile-first)
├── app.js           # All logic (state, render, persistence, API fetch)
├── manifest.json    # PWA manifest
├── sw.js            # Service worker (cache-first offline support)
├── icons/
│   └── icon-1024.png
└── README.md
```

## Quick Wins (suggested next steps)

1. **Export/Import JSON** — add a button to download `localStorage` data as a `.json` file and re-import it (great for switching devices)
2. **Weekly history** — store completed workouts by week so you can look back at past progress
