/**
 * Allows a series of Blob-convertible objects (ArrayBuffer, Blob, String, etc) to be added to a buffer. Seeking and
 * overwriting of blobs is allowed.
 *
 * You can supply a FileWriter, in which case the BlobBuffer is just used as temporary storage before it writes it
 * through to the disk.
 *
 * By Nicholas Sherlock
 *
 * Released under the WTFPLv2 https://en.wikipedia.org/wiki/WTFPL
 */

/**
 * Returns a promise that converts the blob to an ArrayBuffer
 * @param {Blob} blob
 * @returns {Promise<ArrayBuffer>}
 */
function readBlobAsBuffer(blob) {
	return typeof blob.arrayBuffer === 'function'
		? blob.arrayBuffer()
		: new Promise(function (resolve) {
		const reader = new FileReader();

		reader.addEventListener("loadend", function () {
			resolve(reader.result);
		});

		reader.readAsArrayBuffer(blob);
	});
}

/**
 * @param {Uint8Array|ArrayBuffer|ArrayBufferView|Blob} thing
 * @returns {Promise<Uint8Array>}
 */
function convertToUint8Array(thing) {
	return new Promise(function (resolve) {
		if (thing instanceof Uint8Array) {
			resolve(thing);
		} else if (thing instanceof ArrayBuffer || ArrayBuffer.isView(thing)) {
			resolve(new Uint8Array(thing));
		} else if (thing instanceof Blob) {
			resolve(readBlobAsBuffer(thing).then(buffer => new Uint8Array(buffer)));
		} else {
			//Assume that Blob will know how to read this thing
			resolve(readBlobAsBuffer(new Blob([thing])).then(buffer => new Uint8Array(buffer)));
		}
	});
}

function measureData(data) {
	let result = data.byteLength || data.length || data.size;

	if (!Number.isInteger(result)) {
		throw new Error("Failed to determine size of element");
	}

	return result;
}


export default class BlobBuffer {
	buffer = [];
	writePromise = Promise.resolve();
	fd = null;
	fs = null;

	// Current seek offset
	pos = 0;

	// One more than the index of the highest byte ever written
	length = 0;

	constructor(destination, fs) {
		if (destination && destination.constructor.name === "FileWriter") {
			this.fileWriter = destination;
		} else if (fs && destination) {
			this.fd = destination;
			this.fs = fs;
		}
	}

	/**
	 * Seek to the given absolute offset.
	 *
	 * You may not seek beyond the end of the file (this would create a hole and/or allow blocks to be written in non-
	 * sequential order, which isn't currently supported by the memory buffer backend).
	 */
	seek(offset) {
		if (offset < 0) {
			throw new Error("Offset may not be negative");
		}

		if (isNaN(offset)) {
			throw new Error("Offset may not be NaN");
		}

		if (offset > this.length) {
			throw new Error("Seeking beyond the end of file is not allowed");
		}

		this.pos = offset;
	}

	/**
	 * Write the Blob-convertible data to the buffer at the current seek position.
	 *
	 * Note: If overwriting existing data, the write must not cross preexisting block boundaries (written data must
	 * be fully contained by the extent of a previous write).
	 */
	write(data) {
		const newEntry = {
			offset: this.pos,
			data: data,
			length: measureData(data)
		};
		const isAppend = newEntry.offset >= this.length;

		this.pos += newEntry.length;
		this.length = Math.max(this.length, this.pos);

		// After previous writes complete, perform our write
		this.writePromise = this.writePromise.then(() => {
			if (this.fd) {
				return this._writeToFs(newEntry, this.fs, this.fd);
			} else if (this.fileWriter) {
				return this._writeToFileWriter(newEntry, this.fileWriter);
			} else if (!isAppend) {
				// We might be modifying a write that was already buffered in memory.

				// Slow linear search to find a block we might be overwriting
				for (let i = 0; i < this.buffer.length; i++) {
					const entry = this.buffer[i];

					// If our new entry overlaps the old one in any way...
					if (
						newEntry.offset + newEntry.length <= entry.offset ||
						newEntry.offset >= entry.offset + entry.length
					) continue;

					if (
						newEntry.offset < entry.offset ||
						newEntry.offset + newEntry.length > entry.offset + entry.length
					) throw new Error('Overwrite crosses blob boundaries');

					if (newEntry.offset === entry.offset && newEntry.length === entry.length) {
						// We overwrote the entire block
						entry.data = newEntry.data;

						// We're done
						return;
					}

					return convertToUint8Array(entry.data)
						.then(entryArray => {
							entry.data = entryArray;

							return convertToUint8Array(newEntry.data);
						}).then(newEntryArray => {
							newEntry.data = newEntryArray;

							entry.data.set(newEntry.data, newEntry.offset - entry.offset);
						});
				}
				// Else fall through to do a simple append, as we didn't overwrite any pre-existing blocks
			}

			this.buffer.push(newEntry);
		});
	};

	_writeToFileWriter(newEntry, fileWriter) {
		return new Promise(function (resolve) {
			fileWriter.onwriteend = resolve;

			fileWriter.seek(newEntry.offset);
			fileWriter.write(new Blob([newEntry.data]));
		});
	}

	_writeToFs(newEntry, fs, fd) {
		return new Promise(function (resolve) {
			convertToUint8Array(newEntry.data).then(function (dataArray) {
				let totalWritten = 0;
				const buffer = typeof Buffer === 'function'
					? Buffer.from(dataArray.buffer)
					: new Uint8Array(dataArray.buffer.slice(0));

				const handleWriteComplete = function (err, written, buffer) {
					totalWritten += written;

					if (totalWritten >= buffer.length) {
						resolve();
					} else {
						// We still have more to write...
						fs.write(fd, buffer, totalWritten, buffer.length - totalWritten, newEntry.offset + totalWritten, handleWriteComplete);
					}
				};

				fs.write(fd, buffer, 0, buffer.length, newEntry.offset, handleWriteComplete);
			});
		});
	}

	/**
	 * Finish all writes to the buffer, returning a promise that signals when that is complete.
	 *
	 * If a FileWriter was not provided, the promise is resolved with a Blob that represents the completed BlobBuffer
	 * contents. You can optionally pass in a mimeType to be used for this blob.
	 *
	 * If a FileWriter was provided, the promise is resolved with null as the first argument.
	 */
	complete(mimeType) {
		if (this.fd || this.fileWriter) {
			this.writePromise = this.writePromise.then(() => null);
		} else {
			// After writes complete we need to merge the buffer to give to the caller
			this.writePromise = this.writePromise.then(() => {
				const result = [];

				for (let i = 0; i < this.buffer.length; i++) {
					result.push(this.buffer[i].data);
				}

				return new Blob(result, { type: mimeType });
			});
		}

		return this.writePromise;
	};
}
