import { constants, closeSync, fstatSync, openSync } from 'node:fs';
import { open, close, load, DataType, createExternalBuffer, isNullPointer, type JsExternal } from 'ffi-rs';
import { InspectContextError } from '../packet.ts';

const library = 'inspect-context-ts-openat';
const darwinCloseOnExec = 0x01000000;
const linuxCloseOnExec = 0x80000;
const linuxPath = 0x200000;
const directoryRecordLengthOffset = 16;
const directoryNameLengthOffset = 18;
const darwinDirectoryNameOffset = 21;
const linuxDirectoryNameOffset = 19;
const maxDirectoryEntries = 100_000;
const darwinNoFollowMetadata = 0x20;
const darwinStatLayout = { bytes: 256, device: 0, mode: 4, inode: 8, modifiedSeconds: 48, modifiedNanoseconds: 56, size: 96 };
let references = 0;

export type FileMetadata = { dev: bigint; ino: bigint; mode: bigint; size: bigint; mtimeNs: bigint };

export class NativeFileError extends InspectContextError {
  readonly errnoCode: number;
  constructor(operation: string, errnoCode: number, message: string) {
    super('unsafe_path', `${operation}: ${message}`);
    this.errnoCode = errnoCode;
  }
}
export { closeSync };
export function acquireNativeFiles(): () => void {
  if (process.platform !== 'darwin' && process.platform !== 'linux') throw new InspectContextError('unsupported_platform', 'the isolated native filesystem bridge is verified only on Darwin and Linux');
  if (references === 0) {
    open({ library, path: process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : '' });
    try {
      const root = openSync('/', constants.O_RDONLY | constants.O_DIRECTORY);
      try {
        const expected = fstatSync(root, { bigint: true });
        const actual = readMetadata(root, '.');
        if (actual.dev !== expected.dev || actual.ino !== expected.ino || actual.mode !== expected.mode || actual.size !== expected.size || actual.mtimeNs !== expected.mtimeNs) throw new InspectContextError('unsupported_platform', 'native stat layout does not match the running system');
      } finally { closeSync(root); }
    } catch (error) { close(library); throw error; }
  }
  references++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    references--;
    if (references === 0) close(library);
  };
}
function integerCall(name: string, paramsType: DataType[], paramsValue: unknown[]): number {
  const result = load<DataType.I32, true>({ library, funcName: name, retType: DataType.I32, paramsType, paramsValue, errno: true });
  if (result.value < 0) throw new NativeFileError(name, result.errnoCode, result.errnoMessage);
  return result.value;
}
function openComponent(parent: number, name: string, flags: number): number {
  const closeOnExec = process.platform === 'linux' ? linuxCloseOnExec : darwinCloseOnExec;
  return integerCall('openat', [DataType.I32, DataType.String, DataType.I32], [parent, name, flags | closeOnExec]);
}
function validateComponent(name: string): void {
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\') || name.includes('\0')) throw new InspectContextError('unsafe_path', 'unsafe descriptor component');
}
export function openAt(parent: number, name: string, directory = false): number {
  validateComponent(name);
  return openComponent(parent, name, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | (directory ? constants.O_DIRECTORY : 0));
}
function readMetadata(parent: number, name: string): FileMetadata {
  if (process.platform === 'linux') {
    const descriptor = openComponent(parent, name, linuxPath | constants.O_NOFOLLOW);
    try {
      const metadata = fstatSync(descriptor, { bigint: true });
      return { dev: metadata.dev, ino: metadata.ino, mode: metadata.mode, size: metadata.size, mtimeNs: metadata.mtimeNs };
    } finally { closeSync(descriptor); }
  }
  const bytes = Buffer.alloc(darwinStatLayout.bytes);
  integerCall('fstatat', [DataType.I32, DataType.String, DataType.U8Array, DataType.I32], [parent, name, bytes, darwinNoFollowMetadata]);
  return { dev: BigInt(bytes.readUInt32LE(darwinStatLayout.device)), ino: bytes.readBigUInt64LE(darwinStatLayout.inode), mode: BigInt(bytes.readUInt16LE(darwinStatLayout.mode)), size: bytes.readBigInt64LE(darwinStatLayout.size), mtimeNs: bytes.readBigInt64LE(darwinStatLayout.modifiedSeconds) * 1_000_000_000n + bytes.readBigInt64LE(darwinStatLayout.modifiedNanoseconds) };
}
export function statAt(parent: number, name: string): FileMetadata {
  validateComponent(name);
  return readMetadata(parent, name);
}
export function changeDirectory(descriptor: number): void {
  integerCall('fchdir', [DataType.I32], [descriptor]);
}
export function readDirectory(descriptor: number): string[] {
  const directoryDescriptor = openComponent(descriptor, '.', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  let directory: JsExternal;
  try {
    const opened = load<DataType.External, true>({ library, funcName: 'fdopendir', retType: DataType.External, paramsType: [DataType.I32], paramsValue: [directoryDescriptor], errno: true });
    if (isNullPointer(opened.value)) throw new NativeFileError('fdopendir', opened.errnoCode, opened.errnoMessage);
    directory = opened.value;
  } catch (error) {
    closeSync(directoryDescriptor);
    throw error;
  }
  try {
    const linux = process.platform === 'linux';
    const errnoPointer = load({ library, funcName: linux ? '__errno_location' : '__error', retType: DataType.External, paramsType: [], paramsValue: [] });
    const names: string[] = [];
    while (true) {
      createExternalBuffer(errnoPointer, 4).writeInt32LE(0);
      const next = load<DataType.External, true>({ library, funcName: 'readdir', retType: DataType.External, paramsType: [DataType.External], paramsValue: [directory], errno: true });
      if (isNullPointer(next.value)) {
        if (next.errnoCode !== 0) throw new NativeFileError('readdir', next.errnoCode, next.errnoMessage);
        return names;
      }
      const nameOffset = linux ? linuxDirectoryNameOffset : darwinDirectoryNameOffset;
      const header = createExternalBuffer(next.value, nameOffset);
      const recordLength = header.readUInt16LE(directoryRecordLengthOffset);
      if (recordLength < nameOffset + 1 || recordLength > 4096) throw new InspectContextError('inventory', `unexpected ${linux ? 'Linux' : 'Darwin'} dirent record layout`);
      const record = createExternalBuffer(next.value, recordLength);
      const nameEnd = linux ? record.indexOf(0, nameOffset) : nameOffset + header.readUInt16LE(directoryNameLengthOffset);
      if (nameEnd < nameOffset || nameEnd >= recordLength || record[nameEnd] !== 0) throw new InspectContextError('inventory', 'directory entry name is not terminated');
      const name = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(record.subarray(nameOffset, nameEnd));
      if (name === '.' || name === '..') continue;
      if (names.length >= maxDirectoryEntries) throw new InspectContextError('inventory', 'filesystem entry traversal exceeded 100000 entries');
      names.push(name);
    }
  } finally {
    integerCall('closedir', [DataType.External], [directory]);
  }
}
