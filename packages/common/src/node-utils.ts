import fs from 'fs/promises';

export const fileExists = async (fileName: string): Promise<boolean> => {
  return (await fs.stat(fileName).catch(() => null)) !== null;
};