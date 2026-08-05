import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Excalidraw, exportToBlob, useHandleLibrary } from '@excalidraw/excalidraw';

/** libraries.excalidraw.com 이 돌아올 가짜 URL — main 프로세스에서 가로채서 에디터로 전달 */
const LIBRARY_RETURN_URL = 'https://mirae-excalidraw.local/library-return';

function EditorApp({ onReady }) {
  const apiRef = useRef(null);
  const [excalidrawAPI, setExcalidrawAPI] = useState(null);
  const [theme] = useState('light');
  const onChange = useCallback(() => {}, []);

  useHandleLibrary({ excalidrawAPI });

  useEffect(() => {
    if (typeof onReady !== 'function') return;
    onReady({
      getApi: () => apiRef.current,
      exportPng: async () => {
        const api = apiRef.current;
        if (!api) throw new Error('Excalidraw not ready');
        const elements = api.getSceneElements();
        const appState = api.getAppState();
        const files = api.getFiles();
        if (!elements || !elements.length) {
          throw new Error('EMPTY_SCENE');
        }
        return exportToBlob({
          elements,
          appState: {
            ...appState,
            exportBackground: true,
            exportWithDarkMode: false
          },
          files,
          mimeType: 'image/png',
          quality: 1
        });
      },
      clear: () => {
        const api = apiRef.current;
        if (api) api.resetScene();
      }
    });
  }, [onReady]);

  return (
    <div style={{ width: '100%', height: '100%' }}>
      <Excalidraw
        theme={theme}
        langCode="ko-KR"
        libraryReturnUrl={LIBRARY_RETURN_URL}
        onChange={onChange}
        excalidrawAPI={(api) => {
          apiRef.current = api;
          setExcalidrawAPI(api);
        }}
        UIOptions={{
          canvasActions: {
            loadScene: true,
            export: false,
            saveAsImage: false,
            saveToActiveFile: false
          }
        }}
      />
    </div>
  );
}

window.mountMiraeExcalidraw = function mountMiraeExcalidraw(container, opts) {
  const root = createRoot(container);
  let bridge = null;
  root.render(
    React.createElement(EditorApp, {
      onReady: (b) => {
        bridge = b;
        if (opts && typeof opts.onReady === 'function') opts.onReady(b);
      }
    })
  );
  return {
    exportPng: async () => {
      if (!bridge) throw new Error('Excalidraw not ready');
      return bridge.exportPng();
    },
    clear: () => bridge && bridge.clear(),
    unmount: () => root.unmount()
  };
};
