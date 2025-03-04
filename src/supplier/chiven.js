import axios from 'axios';
import marked from '../utils/markdown';

export default class Chiven {
    static apiUrl = 'http://127.0.0.1:8082/api/ai';
    static token = null;

    static async getModels() {
        const res = await axios.get(`${this.apiUrl}/tags`);
        return res?.data?.models || [];
    }

    static async chat(params) {
        const url = `${this.apiUrl}/chat`;
        const requestData = {
            key: params?.key,
            model: params?.model,
            messages: params?.messages || [],
            stream: params.stream ? true : false,
            temperature: 1,
        };

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': this.token,
                },
                body: JSON.stringify(requestData)
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            // 处理流式响应
            const reader = response.body.getReader();
            const decoder = new TextDecoder('utf-8');
            let buffer = '';

            return new ReadableStream({
                async start(controller) {
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) {
                            controller.close();
                            break;
                        }
                        buffer += decoder.decode(value, { stream: true });
                        const lines = buffer.split('\n');
                        buffer = lines.pop();

                        for (const line of lines) {
                            if (line.trim() !== '') {
                                try {
                                    const chunk = JSON.parse(line);
                                    controller.enqueue(chunk);
                                } catch (error) {
                                    console.error('Error parsing JSON chunk:', error);
                                }
                            }
                        }
                    }
                }
            });
        } catch (error) {
            console.error('Error in Ollama chat API:', error);
            throw error;
        }
    }
    static async renderChat({
        key = null,
        model = 'qwen-plus',
        messages = [],
        thinkOutputId = 'think-output',
        contentOutputId = 'content-output',
        containerSelector = null,
        scroll = true,
        event = (msg) => { }
    } = {}, callback) {
        const state = {
            fullText: '',
            isInThink: false,
            thinkSoFar: '',
            contentSoFar: '',
            hasStartedContent: false,
        };

        // DOM 元素获取与验证
        const elements = {
            thinkOutput: document.getElementById(thinkOutputId),
            contentOutput: document.getElementById(contentOutputId)
        };

        if (!elements.contentOutput) {
            throw new Error('无法找到输出元素');
        }

        // 获取滚动容器
        const scrollContainer = containerSelector
            ? document.querySelector(containerSelector)
            : elements.contentOutput.parentElement;

        // 滚动到底部的函数
        const scrollToBottom = () => {
            if (!scroll) return;
            if (scrollContainer) {
                // 使用 requestAnimationFrame 确保在 DOM 更新后执行滚动
                requestAnimationFrame(() => {
                    const scrollOptions = {
                        top: scrollContainer.scrollHeight,
                        behavior: 'smooth'
                    };
                    scrollContainer.scrollTo(scrollOptions);
                });
            }
        };

        // 处理思考内容
        const renderThink = (thinkText) => {
            if (!elements.thinkOutput) return
            const html = marked.parse(thinkText);
            elements.thinkOutput.innerHTML = html;
            scrollToBottom();
        };

        // 处理主要内容
        const renderContent = (content) => {
            const html = marked.parse(content);
            elements.contentOutput.innerHTML = html;
            document.querySelectorAll('pre code').forEach(block => {
                hljs.highlightElement(block);
            });
            scrollToBottom();
        };

        // 处理数据块
        const processChunk = (chunk) => {
            let index = 0;
            while (index < chunk.length) {
                if (state.isInThink) {
                    const endIndex = chunk.indexOf('</think>', index);
                    if (endIndex !== -1) {
                        state.thinkSoFar += chunk.slice(index, endIndex);
                        renderThink(state.thinkSoFar);
                        state.isInThink = false;
                        event?.('THINKEND');
                        index = endIndex + 8;
                    } else {
                        state.thinkSoFar += chunk.slice(index);
                        renderThink(state.thinkSoFar);
                        break;
                    }
                } else {
                    const startIndex = chunk.indexOf('<think>', index);
                    if (startIndex !== -1) {
                        if (startIndex > index) {
                            if (!state.hasStartedContent) {
                                event?.('CONTENTSTART');
                                state.hasStartedContent = true;
                            }
                            state.contentSoFar += chunk.slice(index, startIndex);
                            renderContent(state.contentSoFar);
                        }
                        state.isInThink = true;
                        event?.('THINKSTART');
                        index = startIndex + 7;
                    } else {
                        if (!state.hasStartedContent) {
                            event?.('CONTENTSTART');
                            state.hasStartedContent = true;
                        }
                        state.contentSoFar += chunk.slice(index);
                        renderContent(state.contentSoFar);
                        break;
                    }
                }
            }
        };

        try {
            event?.('START');
            const stream = await this.chat({
                key, model, messages, stream: true,
            });
            const reader = stream.getReader();

            while (true) {
                const { done, value } = await reader.read();
                if (done || value?.done) {
                    if (state.hasStartedContent) {
                        event?.('CONTENTEND');
                    }
                    event?.('END');
                    let endData = value;
                    endData.message.content = state.contentSoFar;
                    endData.message.fullText = state.fullText;
                    const match = state.fullText.match(/<think>\s*([\s\S]*?)\s*<\/think>/);
                    endData.message.think = match ? match[1] : "";
                    callback(endData);
                    break;
                }
                const chunk = value?.message?.content || '';
                state.fullText += chunk;
                processChunk(chunk);
            }
        } catch (error) {
            console.error('渲染聊天内容时出错:', error);
            event?.('ERROR');
            throw error;
        }
    }
}