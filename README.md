# blendboxd

Film picks your whole group will enjoy, blended from everyone's Letterboxd export.

**Open it: <https://bertblookers.github.io/blendboxd/>**

Nothing to install. It runs in your browser.

## How to use it

1. **Collect the exports.** Everyone in the group downloads their Letterboxd data.
   Sign in on **letterboxd.com in a browser** (the phone app can't export), open
   <https://letterboxd.com/settings/data/> and click **Export your data**. A `.zip`
   downloads. Each person sends you theirs, unopened.
2. **Put all the zips in one folder** on your computer.
3. **Open the site** and follow the three steps on the page: paste a TMDb API key,
   pick the folder, press **Blend**.

The first blend takes a few minutes, because every film gets looked up on TMDb
once. Your browser keeps what it looked up, so later blends take seconds.

One export on its own works too: you then get picks for just that person.

## The TMDb API key

blendboxd gets its film data (genres, directors, posters, recommendations) from
[TMDb](https://www.themoviedb.org/), which needs a free API key. Either ask the
person who sent you the link for theirs, or get your own:

1. Make a free account on [themoviedb.org](https://www.themoviedb.org/signup).
2. Go to [Settings → API](https://www.themoviedb.org/settings/api) and request a
   key. The form asks what it's for; personal, non-commercial use is fine.
3. Copy the **API Key** (32 characters), not the long "Read Access Token".

The key is saved in your browser only.

## What you get

- A ranked wall of films nobody in the group has seen yet, each with a score per
  person and a combined score.
- **Members**: switch people in and out of the blend; the ranking updates instantly.
- **Vibe**: re-rank for the mood you're in (shorter, lighter, calmer, denser…).
- Filters for genre, country, decade, runtime, year and TMDb rating.
- It keeps searching wider in the background while you browse, so the list
  grows for a few minutes after it first appears.

## Privacy

- Your exports are read **inside your browser** and are never uploaded anywhere.
  There is no blendboxd server.
- Only film titles and years (and TMDb film numbers) are sent to TMDb, to look the
  films up.
- Your browser stores the API key and a cache of TMDb film data (for at most 150
  days) on your own device. Clearing the site's data in your browser removes both.
- An export zip also contains that person's email address, so share zips only with
  people you trust. blendboxd itself only reads the username.

## Browsers

Works in current Chrome, Edge, Firefox and Safari. On a phone, use **Choose .zip
files** instead of **Choose folder**. Chrome and Edge can reopen the same folder
next time.

## How it works

Each person's ratings and likes become a taste profile: films you rated above your
own average pull the profile toward their genres, keywords, directors, countries
and decades, and films you rated below it push it away. Candidate films come from
TMDb's recommendations for everyone's favourites plus the group's strongest
genres. Every candidate is scored against each profile, and the scores are
combined so that a film only ranks high when it suits *everyone*, not just one
enthusiast.

## Credits

<a href="https://www.themoviedb.org/"><img src="assets/tmdb-logo.svg" alt="The Movie Database (TMDB)" width="160"></a>

This application uses TMDB and the TMDB APIs but is not endorsed, certified, or
otherwise approved by TMDB. blendboxd is not affiliated with Letterboxd. See
[ATTRIBUTION.md](ATTRIBUTION.md) for all data sources and third-party code.

## License

The code is licensed under the GNU Affero General Public License v3.0 —
see [LICENSE](LICENSE). SPDX: `AGPL-3.0-only`.
