export function extend(base, top) {
    const target = {};

    [base, top].forEach(obj => {
        for (let prop in obj) {
            if (Object.prototype.hasOwnProperty.call(obj, prop)) {
                target[prop] = obj[prop];
            }
        }
    });

    return target;
}

/**
 * Decode a Base64 data URL into a binary string.
 *
 * @return {String} The binary string
 */
export function decodeBase64WebPDataURL(url) {
    if (typeof url !== "string" || !url.match(/^data:image\/webp;base64,/i)) {
        throw new Error("Failed to decode WebP Base64 URL");
    }

    return window.atob(url.substring("data:image\/webp;base64,".length));
}

/**
 * Convert the given canvas to a WebP encoded image and return the image data as a string.
 *
 * @return {String}
 */
export function renderAsWebP(canvas, quality) {
    let
        frame = typeof canvas === 'string' && /^data:image\/webp/.test(canvas)
            ? canvas
            : canvas.toDataURL('image/webp', quality);

    return decodeBase64WebPDataURL(frame);
}

/**
 * @param {String} string
 * @returns {number}
 */
export function byteStringToUint32LE(string) {
    let
        a = string.charCodeAt(0),
        b = string.charCodeAt(1),
        c = string.charCodeAt(2),
        d = string.charCodeAt(3);

    return (a | (b << 8) | (c << 16) | (d << 24)) >>> 0;
}

/**
 * Extract a VP8 keyframe from a WebP image file.
 *
 * @param {String} webP - Raw binary string
 *
 * @returns {{hasAlpha: boolean, frame: string}}
 */
export function extractKeyframeFromWebP(webP) {
    let
        cursor = webP.indexOf('VP8', 12); // Start the search after the 12-byte file header

    if (cursor === -1) {
        throw new Error("Bad image format, does this browser support WebP?");
    }

    let
        hasAlpha = false;

    /* Cursor now is either directly pointing at a "VP8 " keyframe, or a "VP8X" extended format file header
     * Seek through chunks until we find the "VP8 " chunk we're interested in
     */
    while (cursor < webP.length - 8) {
        let
            chunkLength, fourCC;

        fourCC = webP.substring(cursor, cursor + 4);
        cursor += 4;

        chunkLength = byteStringToUint32LE(webP.substring(cursor, cursor + 4));
        cursor += 4;

        switch (fourCC) {
            case "VP8 ":
                return {
                    frame: webP.substring(cursor, cursor + chunkLength),
                    hasAlpha: hasAlpha
                };

            case "ALPH":
                hasAlpha = true;
                /* But we otherwise ignore the content of the alpha chunk, since we don't have a decoder for it
                 * and it isn't VP8-compatible
                 */
                break;
        }

        cursor += chunkLength;

        if ((chunkLength & 0x01) !== 0) {
            cursor++;
            // Odd-length chunks have 1 byte of trailing padding that isn't included in their length
        }
    }

    throw new Error("Failed to find VP8 keyframe in WebP image, is this image mistakenly encoded in the Lossless WebP format?");
}

export const
    EBML_SIZE_UNKNOWN = -1,
    EBML_SIZE_UNKNOWN_5_BYTES = -2;

// Just a little utility so we can tag values as floats for the EBML encoder's benefit
export function EBMLFloat32(value) {
    this.value = value;
}

export function EBMLFloat64(value) {
    this.value = value;
}

/**
 * Write the given EBML object to the provided ArrayBufferStream.
 *
 * @param buffer
 * @param {Number} bufferFileOffset - The buffer's first byte is at this position inside the video file.
 *                                    This is used to complete offset and dataOffset fields in each EBML structure,
 *                                    indicating the file offset of the first byte of the EBML element and
 *                                    its data payload.
 * @param {*} ebml
 */
export function writeEBML(buffer, bufferFileOffset, ebml) {
    // Is the ebml an array of sibling elements?
    if (Array.isArray(ebml)) {
        for (let i = 0; i < ebml.length; i++) {
            writeEBML(buffer, bufferFileOffset, ebml[i]);
        }
        // Is this some sort of raw data that we want to write directly?
    } else if (typeof ebml === "string") {
        buffer.writeString(ebml);
    } else if (ebml instanceof Uint8Array) {
        buffer.writeBytes(ebml);
    } else if (ebml.id){
        // We're writing an EBML element
        ebml.offset = buffer.pos + bufferFileOffset;

        buffer.writeUnsignedIntBE(ebml.id); // ID field

        // Now we need to write the size field, so we must know the payload size:

        if (Array.isArray(ebml.data)) {
            // Writing an array of child elements. We won't try to measure the size of the children up-front

            let
                sizePos, dataBegin, dataEnd;

            if (ebml.size === EBML_SIZE_UNKNOWN) {
                // Write the reserved all-one-bits marker to note that the size of this element is unknown/unbounded
                buffer.writeByte(0xFF);
            } else if (ebml.size === EBML_SIZE_UNKNOWN_5_BYTES) {
                sizePos = buffer.pos;

                // VINT_DATA is all-ones, so this is the reserved "unknown length" marker:
                buffer.writeBytes([0x0F, 0xFF, 0xFF, 0xFF, 0xFF]);
            } else {
                sizePos = buffer.pos;

                /* Write a dummy size field to overwrite later. 4 bytes allows an element maximum size of 256MB,
                 * which should be plenty (we don't want to have to buffer that much data in memory at one time
                 * anyway!)
                 */
                buffer.writeBytes([0, 0, 0, 0]);
            }

            dataBegin = buffer.pos;

            ebml.dataOffset = dataBegin + bufferFileOffset;
            writeEBML(buffer, bufferFileOffset, ebml.data);

            if (ebml.size !== EBML_SIZE_UNKNOWN && ebml.size !== EBML_SIZE_UNKNOWN_5_BYTES) {
                dataEnd = buffer.pos;

                ebml.size = dataEnd - dataBegin;

                buffer.seek(sizePos);
                buffer.writeEBMLVarIntWidth(ebml.size, 4); // Size field

                buffer.seek(dataEnd);
            }
        } else if (typeof ebml.data === "string") {
            buffer.writeEBMLVarInt(ebml.data.length); // Size field
            ebml.dataOffset = buffer.pos + bufferFileOffset;
            buffer.writeString(ebml.data);
        } else if (typeof ebml.data === "number") {
            // Allow the caller to explicitly choose the size if they wish by supplying a size field
            if (!ebml.size) {
                ebml.size = buffer.measureUnsignedInt(ebml.data);
            }

            buffer.writeEBMLVarInt(ebml.size); // Size field
            ebml.dataOffset = buffer.pos + bufferFileOffset;
            buffer.writeUnsignedIntBE(ebml.data, ebml.size);
        } else if (ebml.data instanceof EBMLFloat64) {
            buffer.writeEBMLVarInt(8); // Size field
            ebml.dataOffset = buffer.pos + bufferFileOffset;
            buffer.writeDoubleBE(ebml.data.value);
        } else if (ebml.data instanceof EBMLFloat32) {
            buffer.writeEBMLVarInt(4); // Size field
            ebml.dataOffset = buffer.pos + bufferFileOffset;
            buffer.writeFloatBE(ebml.data.value);
        } else if (ebml.data instanceof Uint8Array) {
            buffer.writeEBMLVarInt(ebml.data.byteLength); // Size field
            ebml.dataOffset = buffer.pos + bufferFileOffset;
            buffer.writeBytes(ebml.data);
        } else {
            throw new Error("Bad EBML datatype " + typeof ebml.data);
        }
    } else {
        throw new Error("Bad EBML datatype " + typeof ebml.data);
    }
}
