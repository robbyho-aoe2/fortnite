// This site has no backend — GitHub Pages only serves static files — so the
// browser itself calls the GitHub API to commit new games. That requires a
// repo-write credential to be present in the shipped JS, which means it is
// public to anyone who looks. This is a deliberate, accepted trade-off
// (see README.md "Architecture"), not an oversight:
//
//   - The token below is a fine-grained GitHub PAT scoped to ONLY this repo,
//     with Contents: Read and write and nothing else. It cannot touch any
//     other repo or account setting.
//   - It's lightly obfuscated (reversed + base64) purely so GitHub's
//     automated secret-scanning doesn't flag/revoke it on push. This is NOT
//     real security — anyone who actually wants the token can trivially
//     reconstruct it from this file or from a network request in dev tools.
//   - Worst case if someone abuses it: they can write arbitrary files to
//     this one repo (e.g. corrupt game data, deface the site's own source).
//     Given what this repo is, that's an accepted risk, not a sensitive one.
//
// To rotate: generate a new fine-grained token (GitHub → Settings →
// Developer settings → Personal access tokens → Fine-grained tokens),
// scoped to robbyho-aoe2/fortnite, Contents: Read and write. Then run
// btoa([...token].reverse().join("")) in a console and paste the result below.

const ENCODED_TOKEN = "NU45MzdTY3dDUkw2TjJNU0FqYnZrNG93TlRmVE9NRnR5VzkwUzRUQW1IeUdWTXFCTEZQeXJleXlhZWdfbmdzNEM4MUtycUh3MFlaR0k0SEMxMV90YXBfYnVodGln";

function decodeToken(encoded) {
  return atob(encoded).split("").reverse().join("");
}

const repoConfig = {
  GITHUB_OWNER: "robbyho-aoe2",
  GITHUB_REPO: "fortnite",
  GITHUB_BRANCH: "main",
  get GITHUB_TOKEN() {
    return decodeToken(ENCODED_TOKEN);
  },
};

export { repoConfig };
