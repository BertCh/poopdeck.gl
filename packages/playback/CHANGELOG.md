# @poopdeck.gl/playback

## 0.4.0

### Minor Changes

- `PlaybackGovernor.isScrubbing` + `scrubstart`/`scrubend` events, and the
  optional `BufferSource.setInteractive(bool)` broadcast (drives scrub-LOD
  in the tileset). The interactive bit is asserted on source add and cleared
  on remove/replace/dispose.

## 0.3.0

## 0.2.0

## 0.1.1

### Patch Changes

- Correct the published READMEs: the 0.1.0 tarballs still carried the
  pre-release "Not yet published to npm — consume it from the monorepo"
  banners. Install sections now lead with the real `npm install` commands.
