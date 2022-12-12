import { WebMWriter } from '../src/WebMWriter.mjs';
import { Blob } from 'node:buffer';

describe("WebMWriter", function() {
	it("Doesn't crash when rendering a video with zero frames", async () => {
		globalThis.Blob = Blob;
		const videoWriter = new WebMWriter({ frameRate: 30 });

		const webMBlob = await videoWriter.complete();
		expect(webMBlob.size).toBeGreaterThanOrEqual(12);
	});
});
