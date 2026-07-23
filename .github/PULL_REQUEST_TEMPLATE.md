## What changed

<!-- Describe the change and the user-visible impact. -->

## Why

<!-- Explain the problem or motivation. -->

## Safety checklist

- [ ] Signed URL paths and query strings remain byte-for-byte intact.
- [ ] No cookie, token, full signed media URL, or personal data is included.
- [ ] Akamai URLs are used only when returned natively by Bilibili.
- [ ] New or changed network behavior is covered by tests.

## Validation

- [ ] `npm run check`
- [ ] `npm test`
- [ ] Manually tested on a Bilibili video page
