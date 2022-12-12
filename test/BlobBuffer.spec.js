import { Blob } from 'node:buffer';
import BlobBuffer from '../src/BlobBuffer.mjs';

// Returns a promise that converts the blob to a string
async function readBlobAsString(blob) {
    return new TextDecoder().decode(await blob.arrayBuffer());
}

describe("BlobBuffer", function() {
    it("The position is initially 0", function() {
        const blobBuffer = new BlobBuffer();

        expect(blobBuffer.pos).toBe(0);
    });

    it("Advances position correctly when writing (Blob)", function() {
        const blobBuffer = new BlobBuffer();

        blobBuffer.write(new Blob(["Hello"]));

        expect(blobBuffer.pos).toBe(5);
        expect(blobBuffer.length).toBe(5);
    });

    it("Advances position correctly when writing (string)", function() {
        const blobBuffer = new BlobBuffer();

        blobBuffer.write(new Blob(["world!"]));

        expect(blobBuffer.pos).toBe(6);
        expect(blobBuffer.length).toBe(6);
    });

    it("Advances position correctly when writing (Uint8Array)", function() {
        const blobBuffer = new BlobBuffer();
        const arr = new Uint8Array(2);

        arr[0] = '?'.charCodeAt(0);
        arr[1] = '!'.charCodeAt(0);

        blobBuffer.write(arr);

        expect(blobBuffer.pos).toBe(2);
        expect(blobBuffer.length).toBe(2);
    });

    it("Advances position correctly when writing (ArrayBuffer)", function() {
        let
            blobBuffer = new BlobBuffer(),
            arr = new Uint8Array(3);

        arr[0] = '?'.charCodeAt(0);
        arr[1] = '!'.charCodeAt(0);
        arr[2] = '!'.charCodeAt(0);

        blobBuffer.write(arr.buffer);

        expect(blobBuffer.pos).toBe(3);
        expect(blobBuffer.length).toBe(3);
    });

    it("Produces the correct string upon reading a complex blobstream", async () => {
        globalThis.Blob = Blob;
        const blobBuffer = new BlobBuffer();

        blobBuffer.write(new Blob(["Hello, "]));
        blobBuffer.write("world");

        const arr = new Uint8Array(2);

        arr[0] = '?'.charCodeAt(0);
        arr[1] = '!'.charCodeAt(0);

        blobBuffer.write(arr);
        blobBuffer.write(arr.buffer);

        const blob = await blobBuffer.complete();
        expect(blob.size).toBe(blobBuffer.pos);
        const buffer = await readBlobAsString(blob);
        expect(buffer).toBe("Hello, world?!?!");
        blobBuffer.seek(2);
        blobBuffer.write("-man");
        expect(blobBuffer.length).toBe(16);

        const blob2 = await blobBuffer.complete();
        expect(blobBuffer.length).toBe(16);
        expect(await readBlobAsString(blob2)).toBe("He-man world?!?!");

        blobBuffer.seek(blobBuffer.length);
        const arrBuffer = new ArrayBuffer(10);
        const array = new Uint8Array(arrBuffer, 1, 4);
        const message = " Hi.";

        for (let i = 0; i < 4; i++) {
            array[i] = message.charCodeAt(i);
        }
        blobBuffer.write(array);

        const blob3 = await blobBuffer.complete();
        expect(blob3.size).toBe(20);
        expect(await readBlobAsString(blob3)).toBe("He-man world?!?! Hi.");
    });
});
