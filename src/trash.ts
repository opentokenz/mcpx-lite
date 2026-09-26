import trash from 'trash';

export interface TrashBackend {
  trash(path: string): Promise<void>;
}

export type TrashMove = (paths: string[], options: { glob: boolean }) => Promise<void>;

export function createSystemTrashBackend(move: TrashMove = trash): TrashBackend {
  return {
    trash: (path) => move([path], { glob: false }),
  };
}
