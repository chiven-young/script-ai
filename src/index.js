import Ollama from "./supplier/ollama";
import Chiven from './supplier/chiven';
import Tools from "./utils";

export default class scriptAI {
    static ollama = Ollama;
    static chiven = Chiven;
    static tools = Tools;
};