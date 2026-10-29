// A React wrapper. Copy into your app; import the SDK from wherever you put it.
//
//   <WordEditor
//     document="/files/report.docx"
//     author={user.name}
//     onSave={({ name, blob }) => fetch(`/api/files/${encodeURIComponent(name)}`, { method: 'PUT', body: blob })}
//     style={{ height: '80vh' }}
//   />
import { useEffect, useRef } from 'react';
import { WordCraftEditor } from 'wordcraft-embed';

export default function WordEditor({ src = '/wordcraft/', document, documentName, author, onSave, onDirtyChange, onError, className, style }) {
  const container = useRef(null);
  const editor = useRef(null);
  // Callbacks change on every render; read the latest ones without remounting the editor.
  const handlers = useRef({});
  handlers.current = { onSave, onDirtyChange, onError };

  useEffect(() => {
    const instance = new WordCraftEditor(container.current, {
      src,
      author,
      onSave: (file) => handlers.current.onSave?.(file),
      onDirtyChange: (dirty) => handlers.current.onDirtyChange?.(dirty),
      onError: (error) => handlers.current.onError?.(error),
    });
    editor.current = instance;
    return () => instance.destroy();
  }, [src, author]);

  useEffect(() => {
    if (document) editor.current?.open(document, documentName).catch((error) => handlers.current.onError?.(error));
  }, [document, documentName, src, author]);

  return <div ref={container} className={className} style={{ height: 600, ...style }} />;
}
