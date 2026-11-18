/**
 * 前端向量化引擎 V2 - 基于 Transformers.js
 * 修复：兼容 file:// 和 HTTP 两种协议，多CDN源，国内镜像
 *
 * 加载策略：
 * 1. 优先使用 HTML 中 <script type="module"> 预加载到 window.__transformers__ 的对象
 * 2. 回退到动态 import()（仅 HTTP 协议下可用）
 * 3. 全部失败则使用关键词检索降级
 */
class TCMEmbedder {
    constructor(options = {}) {
        this.pipeline = null;
        this.isLoaded = false;
        this.isLoading = false;
        this.loadProgress = 0;
        // 使用较小的 all-MiniLM-L6-v2 模型（~30MB），对中文也有效
        this.modelName = options.modelName || 'Xenova/all-MiniLM-L6-v2';
        this.dimensions = 384;
        this._loadPromise = null;
    }

    async init(onProgress) {
        if (this.isLoaded) {
            if (onProgress) onProgress(100, '模型已就绪');
            return;
        }
        if (this.isLoading && this._loadPromise) {
            return this._loadPromise;
        }

        this.isLoading = true;
        this._loadPromise = this._doInit(onProgress);

        try {
            await this._loadPromise;
        } finally {
            this.isLoading = false;
            this._loadPromise = null;
        }
    }

    async _doInit(onProgress) {
        const report = (p, s) => { this.loadProgress = p; if (onProgress) onProgress(p, s); };

        try {
            // 检查协议
            if (location.protocol === 'file:') {
                report(-1, '检测到 file:// 协议，向量化功能需要 HTTP 服务器。请运行: npx http-server -p 8000 然后访问 http://localhost:8000/tcm-rag.html');
                throw new Error('请通过 HTTP 服务器打开本页面');
            }

            report(5, '正在获取 Transformers.js 库...');

            // 策略1：使用 HTML 预加载的全局对象
            let transformers = window.__transformers__ || null;

            // 策略2：等待预加载完成（最多等30秒）
            if (!transformers && !window.__transformersError__) {
                report(8, '等待 Transformers.js 预加载...');
                for (let i = 0; i < 60; i++) {
                    await new Promise(r => setTimeout(r, 500));
                    if (window.__transformersReady__) {
                        transformers = window.__transformers__;
                        break;
                    }
                    if (window.__transformersError__) break;
                }
            }

            // 策略3：预加载失败，尝试动态 import（带超时）
            if (!transformers) {
                report(8, '预加载未就绪，尝试动态加载...');
                const cdnList = [
                    { url: '/node_modules/@huggingface/transformers/dist/transformers.min.js', timeout: 10000, name: '本地服务器' },
                    { url: 'https://esm.sh/@huggingface/transformers@3.4.1', timeout: 20000, name: 'esm.sh v3.4' },
                    { url: 'https://esm.sh/@xenova/transformers@2.17.2', timeout: 20000, name: 'esm.sh v2.17' },
                    { url: 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.4.1/+esm', timeout: 15000, name: 'jsdelivr v3.4' },
                    { url: 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2', timeout: 15000, name: 'jsdelivr v2.17' },
                    { url: 'https://unpkg.com/@xenova/transformers@2.17.2', timeout: 15000, name: 'unpkg v2.17' }
                ];
                for (const src of cdnList) {
                    try {
                        const result = await Promise.race([
                            import(src.url),
                            new Promise((_, rej) => setTimeout(() => rej(new Error('超时')), src.timeout))
                        ]);
                        transformers = result;
                        console.log('[Embedder] 动态加载成功:', src.name);
                        break;
                    } catch (e) {
                        console.warn('[Embedder] CDN失败:', src.name, e.message);
                    }
                }
            }

            if (!transformers) {
                throw new Error('Transformers.js 加载失败。请检查网络或启动本地HTTP服务器。');
            }

            const { pipeline, env } = transformers;

            // 配置模型加载环境
            if (env) {
                env.allowLocalModels = false;
                try { env.useBrowserCache = false; } catch(e) {}
                // 只设 remoteHost，不设 remotePathTemplate（用默认值）
                try {
                    env.remoteHost = window.location.origin + '/models';
                } catch(e) {}
            }
            console.log('[Embedder] env 配置完成, remoteHost:', env?.remoteHost);

            report(15, '正在下载 Embedding 模型（首次约30MB）...');
            console.log('[Embedder] 开始加载模型:', this.modelName);

            this.pipeline = await pipeline('feature-extraction', this.modelName, {
                progress_callback: (progress) => {
                    if (progress.status === 'download') {
                        const pct = progress.progress ? Math.round(progress.progress) : 0;
                        const total = progress.total ? this._formatSize(progress.total) : '未知';
                        const loaded = progress.loaded ? this._formatSize(progress.loaded) : '';
                        report(15 + Math.round(pct * 0.7), `下载模型: ${loaded}/${total} (${pct}%)`);
                    } else if (progress.status === 'ready') {
                        report(90, '模型下载完成，正在初始化...');
                    } else if (progress.status === 'progress') {
                        // 有些版本用 progress 而不是 download
                        const pct = progress.progress ? Math.round(progress.progress) : 0;
                        report(15 + Math.round(pct * 0.7), `加载进度: ${pct}%`);
                    }
                }
            });

            this.isLoaded = true;
            report(100, '向量化引擎就绪');
            console.log('[Embedder] 加载成功:', this.modelName, '维度:', this.dimensions);

        } catch (error) {
            console.error('[Embedder] 失败:', error);
            report(-1, '加载失败: ' + error.message);
            throw error;
        }
    }

    async embed(text) {
        if (!this.isLoaded || !this.pipeline) {
            throw new Error('模型未加载');
        }
        const truncated = text.length > 800 ? text.substring(0, 800) : text;
        const output = await this.pipeline(truncated, {
            pooling: 'mean',
            normalize: true
        });
        return Array.from(output.data);
    }

    async embedBatch(texts, onProgress) {
        const embeddings = [];
        for (let i = 0; i < texts.length; i++) {
            embeddings.push(await this.embed(texts[i]));
            if (onProgress) onProgress(i + 1, texts.length);
            if (i % 5 === 0) await new Promise(r => setTimeout(r, 0));
        }
        return embeddings;
    }

    _formatSize(bytes) {
        if (bytes < 1024) return bytes + 'B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'KB';
        return (bytes / (1024 * 1024)).toFixed(1) + 'MB';
    }

    getStatus() {
        return {
            isLoaded: this.isLoaded,
            isLoading: this.isLoading,
            progress: this.loadProgress,
            modelName: this.modelName,
            dimensions: this.dimensions,
            protocol: location.protocol
        };
    }
}

window.TCMEmbedder = TCMEmbedder;
