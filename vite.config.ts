import {defineConfig} from 'vite';import react from '@vitejs/plugin-react';
export default defineConfig({plugins:[react()],root:'web',build:{outDir:'../dist',emptyOutDir:true,rollupOptions:{input:{main:'web/index.html',test:'web/test.html'}}},server:{host:'127.0.0.1',proxy:{'/api':'http://127.0.0.1:8787'}}});
