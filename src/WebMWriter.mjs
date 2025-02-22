/**
 * WebM video encoder for Google Chrome. This implementation is suitable for creating very large video files, because
 * it can stream Blobs directly to a FileWriter without buffering the entire video in memory.
 *
 * When FileWriter is not available or not desired, it can buffer the video in memory as a series of Blobs which are
 * eventually returned as one composite Blob.
 *
 * By Nicholas Sherlock.
 *
 * Based on the ideas from Whammy: https://github.com/antimatter15/whammy
 *
 * Released under the WTFPLv2 https://en.wikipedia.org/wiki/WTFPL
 */

import ArrayBufferDataStream from './ArrayBufferDataStream.mjs';
import BlobBuffer from './BlobBuffer.mjs';
import {
    EBML_SIZE_UNKNOWN_5_BYTES,
    EBMLFloat64,
    extend,
    extractKeyframeFromWebP,
    renderAsWebP,
    writeEBML
} from './utils.mjs';


/**
 * @typedef {Object} Frame
 * @property {string} frame - Raw VP8 keyframe data
 * @property {string} alpha - Raw VP8 keyframe with alpha represented as luminance
 * @property {Number} duration
 * @property {Number} trackNumber - From 1 to 126 (inclusive)
 * @property {Number} timecode
 */

/**
 * @typedef {Object} Cluster
 * @property {Number} timecode - Start time for the cluster
 */

export function WebMWriter(options) {
    let
        MAX_CLUSTER_DURATION_MSEC = 5000,
        DEFAULT_TRACK_NUMBER = 1,

        writtenHeader = false,
        videoWidth = 0, videoHeight = 0,

        /**
         * @type {[HTMLCanvasElement]}
         */
        alphaBuffer = null,

        /**
         * @type {[CanvasRenderingContext2D]}
         */
        alphaBufferContext = null,

        /**
         * @type {[ImageData]}
         */
        alphaBufferData = null,

        /**
         *
         * @type {Frame[]}
         */
        clusterFrameBuffer = [],
        clusterStartTime = 0,
        clusterDuration = 0,

        optionDefaults = {
            quality: 0.95,       // WebM image quality from 0.0 (worst) to 0.99999 (best), 1.00 (WebP lossless) is not supported

            transparent: false,      // True if an alpha channel should be included in the video
            alphaQuality: undefined, // Allows you to set the quality level of the alpha channel separately.
                                     // If not specified this defaults to the same value as `quality`.

            fileWriter: null,    // Chrome FileWriter in order to stream to a file instead of buffering to memory (optional)
            fd: null,            // Node.JS file descriptor to write to instead of buffering (optional)

            // You must supply one of:
            frameDuration: null, // Duration of frames in milliseconds
            frameRate: null,     // Number of frames per second
        },

        seekPoints = {
            Cues: {id: new Uint8Array([0x1C, 0x53, 0xBB, 0x6B]), positionEBML: null},
            SegmentInfo: {id: new Uint8Array([0x15, 0x49, 0xA9, 0x66]), positionEBML: null},
            Tracks: {id: new Uint8Array([0x16, 0x54, 0xAE, 0x6B]), positionEBML: null},
        },

        ebmlSegment, // Root element of the EBML document

        segmentDuration = {
            "id": 0x4489, // Duration
            "data": new EBMLFloat64(0)
        },

        seekHead,

        cues = [],

        blobBuffer = new BlobBuffer(options.fileWriter || options.fd);

    function fileOffsetToSegmentRelative(fileOffset) {
        return fileOffset - ebmlSegment.dataOffset;
    }

    /**
     * Extracts the transparency channel from the supplied canvas and uses it to create a VP8 alpha channel bitstream.
     *
     * @param {HTMLCanvasElement} source
     *
     * @return {HTMLCanvasElement}
     */
    function convertAlphaToGrayscaleImage(source) {
        if (
            alphaBuffer === null ||
            alphaBuffer.width !== source.width ||
            alphaBuffer.height !== source.height
        ) {
            alphaBuffer = document.createElement("canvas");
            alphaBuffer.width = source.width;
            alphaBuffer.height = source.height;

            alphaBufferContext = alphaBuffer.getContext("2d");
            alphaBufferData = alphaBufferContext.createImageData(
                alphaBuffer.width,
                alphaBuffer.height
            );
        }

        let
            sourceContext = source.getContext("2d"),
            sourceData = sourceContext.getImageData(0, 0, source.width, source.height).data,
            destData = alphaBufferData.data,
            dstCursor = 0,
            srcEnd = source.width * source.height * 4;

        for (
            let srcCursor = 3 /* Since pixel byte order is RGBA */;
            srcCursor < srcEnd;
            srcCursor += 4
        ) {
            let
                alpha = sourceData[srcCursor];

            // Turn the original alpha channel into a brightness value (ends up being the Y in YUV)
            destData[dstCursor++] = alpha;
            destData[dstCursor++] = alpha;
            destData[dstCursor++] = alpha;
            destData[dstCursor++] = 255;
        }

        alphaBufferContext.putImageData(alphaBufferData, 0, 0);

        return alphaBuffer;
    }

    /**
     * Create a SeekHead element with descriptors for the points in the global seekPoints array.
     *
     * 5 bytes of position values are reserved for each node, which lie at the offset point.positionEBML.dataOffset,
     * to be overwritten later.
     */
    function createSeekHead() {
        let
            seekPositionEBMLTemplate = {
                "id": 0x53AC, // SeekPosition
                "size": 5, // Allows for 32GB video files
                "data": 0 // We'll overwrite this when the file is complete
            },

            result = {
                "id": 0x114D9B74, // SeekHead
                "data": []
            };

        for (let name in seekPoints) {
            let
                seekPoint = seekPoints[name];

            seekPoint.positionEBML = Object.create(seekPositionEBMLTemplate);

            result.data.push({
                "id": 0x4DBB, // Seek
                "data": [
                    {
                        "id": 0x53AB, // SeekID
                        "data": seekPoint.id
                    },
                    seekPoint.positionEBML
                ]
            });
        }

        return result;
    }

    /**
     * Write the WebM file header to the stream.
     */
    function writeHeader() {
        seekHead = createSeekHead();

        let
            ebmlHeader = {
                "id": 0x1a45dfa3, // EBML
                "data": [
                    {
                        "id": 0x4286, // EBMLVersion
                        "data": 1
                    },
                    {
                        "id": 0x42f7, // EBMLReadVersion
                        "data": 1
                    },
                    {
                        "id": 0x42f2, // EBMLMaxIDLength
                        "data": 4
                    },
                    {
                        "id": 0x42f3, // EBMLMaxSizeLength
                        "data": 8
                    },
                    {
                        "id": 0x4282, // DocType
                        "data": "webm"
                    },
                    {
                        "id": 0x4287, // DocTypeVersion
                        "data": 2
                    },
                    {
                        "id": 0x4285, // DocTypeReadVersion
                        "data": 2
                    }
                ]
            },

            segmentInfo = {
                "id": 0x1549a966, // Info
                "data": [
                    {
                        "id": 0x2ad7b1, // TimecodeScale
                        "data": 1e6 // Times will be in miliseconds (1e6 nanoseconds per step = 1ms)
                    },
                    {
                        "id": 0x4d80, // MuxingApp
                        "data": "webm-writer-js",
                    },
                    {
                        "id": 0x5741, // WritingApp
                        "data": "webm-writer-js"
                    },
                    segmentDuration // To be filled in later
                ]
            },

            videoProperties = [
                {
                    "id": 0xb0, // PixelWidth
                    "data": videoWidth
                },
                {
                    "id": 0xba, // PixelHeight
                    "data": videoHeight
                }
            ];

        if (options.transparent) {
            videoProperties.push(
                {
                    "id": 0x53C0, // AlphaMode
                    "data": 1
                }
            );
        }

        let
            tracks = {
                "id": 0x1654ae6b, // Tracks
                "data": [
                    {
                        "id": 0xae, // TrackEntry
                        "data": [
                            {
                                "id": 0xd7, // TrackNumber
                                "data": DEFAULT_TRACK_NUMBER
                            },
                            {
                                "id": 0x73c5, // TrackUID
                                "data": DEFAULT_TRACK_NUMBER
                            },
                            {
                                "id": 0x9c, // FlagLacing
                                "data": 0
                            },
                            {
                                "id": 0x22b59c, // Language
                                "data": "und"
                            },
                            {
                                "id": 0x86, // CodecID
                                "data": "V_VP8"
                            },
                            {
                                "id": 0x258688, // CodecName
                                "data": "VP8"
                            },
                            {
                                "id": 0x83, // TrackType
                                "data": 1
                            },
                            {
                                "id": 0xe0,  // Video
                                "data": videoProperties
                            }
                        ]
                    }
                ]
            };

        ebmlSegment = {
            "id": 0x18538067, // Segment
            "size": EBML_SIZE_UNKNOWN_5_BYTES, // We'll seek back and fill this in at completion
            "data": [
                seekHead,
                segmentInfo,
                tracks,
            ]
        };

        let
            bufferStream = new ArrayBufferDataStream(256);

        writeEBML(bufferStream, blobBuffer.pos, [ebmlHeader, ebmlSegment]);
        blobBuffer.write(bufferStream.getAsDataArray());

        // Now we know where these top-level elements lie in the file:
        seekPoints.SegmentInfo.positionEBML.data = fileOffsetToSegmentRelative(segmentInfo.offset);
        seekPoints.Tracks.positionEBML.data = fileOffsetToSegmentRelative(tracks.offset);

        writtenHeader = true;
    }

    /**
     * Create a BlockGroup element to hold the given keyframe (used when alpha support is required)
     *
     * @param {Frame} keyframe
     *
     * @return A BlockGroup EBML element
     */
    function createBlockGroupForTransparentKeyframe(keyframe) {
        let
            block, blockAdditions,

            bufferStream = new ArrayBufferDataStream(1 + 2 + 1);

        // Create a Block to hold the image data:

        if (!(keyframe.trackNumber > 0 && keyframe.trackNumber < 127)) {
            throw new Error("TrackNumber must be > 0 and < 127");
        }

        bufferStream.writeEBMLVarInt(keyframe.trackNumber); // Always 1 byte since we limit the range of trackNumber
        bufferStream.writeU16BE(keyframe.timecode);
        bufferStream.writeByte(0); // Flags byte

        block = {
            "id": 0xA1, // Block
            "data": [
                bufferStream.getAsDataArray(),
                keyframe.frame
            ]
        };

        blockAdditions = {
            "id": 0x75A1, // BlockAdditions
            "data": [
                {
                    "id": 0xA6, // BlockMore
                    "data": [
                        {
                            "id": 0xEE, // BlockAddID
                            "data": 1   // Means "BlockAdditional has a codec-defined meaning, pass it to the codec"
                        },
                        {
                            "id": 0xA5, // BlockAdditional
                            "data": keyframe.alpha // The actual alpha channel image
                        }
                    ]
                }
            ]
        };

        return {
            "id": 0xA0, // BlockGroup
            "data": [
                block,
                blockAdditions
            ]
        };
    }

    /**
     * Create a SimpleBlock element to hold the given keyframe.
     *
     * @param {Frame} keyframe
     *
     * @return A SimpleBlock EBML element.
     */
    function createSimpleBlockForKeyframe(keyframe) {
        let
            bufferStream = new ArrayBufferDataStream(1 + 2 + 1);

        if (!(keyframe.trackNumber > 0 && keyframe.trackNumber < 127)) {
            throw new Error("TrackNumber must be > 0 and < 127");
        }

        bufferStream.writeEBMLVarInt(keyframe.trackNumber); // Always 1 byte since we limit the range of trackNumber
        bufferStream.writeU16BE(keyframe.timecode);

        // Flags byte
        bufferStream.writeByte(
            1 << 7 // Keyframe
        );

        return {
            "id": 0xA3, // SimpleBlock
            "data": [
                bufferStream.getAsDataArray(),
                keyframe.frame
            ]
        };
    }

    /**
     * Create either a SimpleBlock or BlockGroup (if alpha is required) for the given keyframe.
     *
     * @param {Frame} keyframe
     */
    function createContainerForKeyframe(keyframe) {
        if (keyframe.alpha) {
            return createBlockGroupForTransparentKeyframe(keyframe);
        }

        return createSimpleBlockForKeyframe(keyframe);
    }

    /**
     * Create a Cluster EBML node.
     *
     * @param {Cluster} cluster
     *
     * Returns an EBML element.
     */
    function createCluster(cluster) {
        return {
            "id": 0x1f43b675,
            "data": [
                {
                    "id": 0xe7, // Timecode
                    "data": Math.round(cluster.timecode)
                }
            ]
        };
    }

    function addCuePoint(trackIndex, clusterTime, clusterFileOffset) {
        cues.push({
            "id": 0xBB, // Cue
            "data": [
                {
                    "id": 0xB3, // CueTime
                    "data": clusterTime
                },
                {
                    "id": 0xB7, // CueTrackPositions
                    "data": [
                        {
                            "id": 0xF7, // CueTrack
                            "data": trackIndex
                        },
                        {
                            "id": 0xF1, // CueClusterPosition
                            "data": fileOffsetToSegmentRelative(clusterFileOffset)
                        }
                    ]
                }
            ]
        });
    }

    /**
     * Write a Cues element to the blobStream using the global `cues` array of CuePoints (use addCuePoint()).
     * The seek entry for the Cues in the SeekHead is updated.
     */
    function writeCues() {
        let
            ebml = {
                "id": 0x1C53BB6B,
                "data": cues
            },

            cuesBuffer = new ArrayBufferDataStream(16 + cues.length * 32); // Pretty crude estimate of the buffer size we'll need

        writeEBML(cuesBuffer, blobBuffer.pos, ebml);
        blobBuffer.write(cuesBuffer.getAsDataArray());

        // Now we know where the Cues element has ended up, we can update the SeekHead
        seekPoints.Cues.positionEBML.data = fileOffsetToSegmentRelative(ebml.offset);
    }

    /**
     * Flush the frames in the current clusterFrameBuffer out to the stream as a Cluster.
     */
    function flushClusterFrameBuffer() {
        if (clusterFrameBuffer.length === 0) {
            return;
        }

        // First work out how large of a buffer we need to hold the cluster data
        let
            rawImageSize = 0;

        for (let i = 0; i < clusterFrameBuffer.length; i++) {
            rawImageSize += clusterFrameBuffer[i].frame.length +
                (clusterFrameBuffer[i].alpha ? clusterFrameBuffer[i].alpha.length : 0);
        }

        let
            buffer = new ArrayBufferDataStream(rawImageSize + clusterFrameBuffer.length * 64), // Estimate 64 bytes per block header

            cluster = createCluster({
                timecode: Math.round(clusterStartTime),
            });

        for (let i = 0; i < clusterFrameBuffer.length; i++) {
            cluster.data.push(createContainerForKeyframe(clusterFrameBuffer[i]));
        }

        writeEBML(buffer, blobBuffer.pos, cluster);
        blobBuffer.write(buffer.getAsDataArray());

        addCuePoint(DEFAULT_TRACK_NUMBER, Math.round(clusterStartTime), cluster.offset);

        clusterFrameBuffer = [];
        clusterStartTime += clusterDuration;
        clusterDuration = 0;
    }

    function validateOptions() {
        // Derive frameDuration setting if not already supplied
        if (!options.frameDuration) {
            if (options.frameRate) {
                options.frameDuration = 1000 / options.frameRate;
            } else {
                throw new Error("Missing required frameDuration or frameRate setting");
            }
        }

        // Avoid 1.0 (lossless) because it creates VP8L lossless frames that WebM doesn't support
        options.quality = Math.max(Math.min(options.quality, 0.99999), 0);

        if (options.alphaQuality === undefined) {
            options.alphaQuality = options.quality;
        } else {
            options.alphaQuality = Math.max(Math.min(options.alphaQuality, 0.99999), 0);
        }
    }

    /**
     *
     * @param {Frame} frame
     */
    function addFrameToCluster(frame) {
        frame.trackNumber = DEFAULT_TRACK_NUMBER;

        // Frame timecodes are relative to the start of their cluster:
        frame.timecode = Math.round(clusterDuration);

        clusterFrameBuffer.push(frame);

        clusterDuration += frame.duration;

        if (clusterDuration >= MAX_CLUSTER_DURATION_MSEC) {
            flushClusterFrameBuffer();
        }
    }

    /**
     * Rewrites the SeekHead element that was initially written to the stream with the offsets of top level elements.
     *
     * Call once writing is complete (so the offset of all top level elements is known).
     */
    function rewriteSeekHead() {
        let
            seekHeadBuffer = new ArrayBufferDataStream(seekHead.size),
            oldPos = blobBuffer.pos;

        // Write the rewritten SeekHead element's data payload to the stream (don't need to update the id or size)
        writeEBML(seekHeadBuffer, seekHead.dataOffset, seekHead.data);

        // And write that through to the file
        blobBuffer.seek(seekHead.dataOffset);
        blobBuffer.write(seekHeadBuffer.getAsDataArray());

        blobBuffer.seek(oldPos);
    }

    /**
     * Rewrite the Duration field of the Segment with the newly-discovered video duration.
     */
    function rewriteDuration() {
        let
            buffer = new ArrayBufferDataStream(8),
            oldPos = blobBuffer.pos;

        // Rewrite the data payload (don't need to update the id or size)
        buffer.writeDoubleBE(clusterStartTime);

        // And write that through to the file
        blobBuffer.seek(segmentDuration.dataOffset);
        blobBuffer.write(buffer.getAsDataArray());

        blobBuffer.seek(oldPos);
    }

    /**
     * Rewrite the size field of the Segment.
     */
    function rewriteSegmentLength() {
        let
            buffer = new ArrayBufferDataStream(10),
            oldPos = blobBuffer.pos;

        // We just need to rewrite the ID and Size fields of the root Segment:
        buffer.writeUnsignedIntBE(ebmlSegment.id);
        buffer.writeEBMLVarIntWidth(blobBuffer.pos - ebmlSegment.dataOffset, 5);

        // And write that on top of the original:
        blobBuffer.seek(ebmlSegment.offset);
        blobBuffer.write(buffer.getAsDataArray());

        blobBuffer.seek(oldPos);
    }

    /**
     * Add a frame to the video.
     *
     * @param {HTMLCanvasElement|String} frame - A Canvas element that contains the frame, or a WebP string
     *                                           you obtained by calling toDataUrl() on an image yourself.
     *
     * @param {HTMLCanvasElement|String} [alpha] - For transparent video, instead of including the alpha channel
     *                                             in your provided `frame`, you can instead provide it separately
     *                                             here. The alpha channel of this alpha canvas will be ignored,
     *                                             encode your alpha information into this canvas' grayscale
     *                                             brightness instead.
     *
     *                                             This is useful because it allows you to paint the colours
     *                                             you need into your `frame` even in regions which are fully
     *                                             transparent (which Canvas doesn't normally let you influence).
     *                                             This allows you to control the colour of the fringing seen
     *                                             around objects on transparent backgrounds.
     *
     * @param {Number} [overrideFrameDuration] - Set a duration for this frame (in milliseconds) that differs
     *                                           from the default
     */
    this.addFrame = function(frame, alpha, overrideFrameDuration) {
        if (!writtenHeader) {
            videoWidth = frame.width || 0;
            videoHeight = frame.height || 0;

            writeHeader();
        }

        let
            keyframe = extractKeyframeFromWebP(renderAsWebP(frame, options.quality)),
            frameDuration, frameAlpha = null;

        if (overrideFrameDuration) {
            frameDuration = overrideFrameDuration;
        } else if (typeof alpha == "number") {
            frameDuration = alpha;
        } else {
            frameDuration = options.frameDuration;
        }

        if (options.transparent) {
            if (alpha instanceof HTMLCanvasElement || typeof alpha === "string") {
                frameAlpha = alpha;
            } else if (keyframe.hasAlpha) {
                frameAlpha = convertAlphaToGrayscaleImage(frame);
            }
        }

        addFrameToCluster({
            frame: keyframe.frame,
            duration: frameDuration,
            alpha: frameAlpha
                ? extractKeyframeFromWebP(renderAsWebP(frameAlpha, options.alphaQuality)).frame
                : null
        });
    };

    /**
     * Finish writing the video and return a Promise to signal completion.
     *
     * If the destination device was memory (i.e. options.fileWriter was not supplied), the Promise is resolved with
     * a Blob with the contents of the entire video.
     */
    this.complete = function() {
        if (!writtenHeader) {
            writeHeader();
        }

        flushClusterFrameBuffer();
        writeCues();

        /*
         * Now the file is at its final length and the position of all elements is known, seek back to the
         * header and update pointers:
         */

        rewriteSeekHead();
        rewriteDuration();
        rewriteSegmentLength();

        return blobBuffer.complete('video/webm');
    };

    this.getWrittenSize = function() {
        return blobBuffer.length;
    };

    options = extend(optionDefaults, options || {});
    validateOptions();
}

