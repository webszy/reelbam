# Mock video fixture

`mock-video-v1.mp4` is a synthetic one-second, 160×90 H.264 color clip generated locally. It contains no third-party images, audio, or footage. It is used only by the development/test Mock provider.

Reproduce with:

```sh
ffmpeg -f lavfi -i 'color=c=0x202536:s=160x90:r=10' -t 1 -c:v libx264 \
  -pix_fmt yuv420p -an -movflags +faststart \
  -metadata title='Reelbam synthetic mock fixture' mock-video-v1.mp4
```

The runtime embeds these exact bytes in `src/fixture.ts`, along with their SHA-256. The fixture test checks file/runtime equality, the fixed hash and MP4 video-track structure. The local integration test reads the object back from R2; `test:video-fixture` also decodes it with FFmpeg.
