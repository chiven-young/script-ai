import { markdownParse } from '../utils/markdown';

export default class Tools {
    static renderMarkdown ({ element, id, content }) {
        let ele = element;
        if (!ele || typeof ele !== 'object') {
            if (!id) return;
            ele = document.getElementById(id);
            if (!ele) return;
        };
        if (!content) return;
        const html = markdownParse(content);
        ele.innerHTML = html;
    }
}