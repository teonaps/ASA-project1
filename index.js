//
import 'dotenv/config';
import { DjsConnect } from "@unitn-asa/deliveroo-js-sdk/client";

const socket = DjsConnect();

socket.onConnect(() => {console.log("connected")});

const me = {id: '', name: '', x: undefined, y: undefined, score: 0};

socket.onYou( ( {id, name, x, y, score} ) => {
    me.id = id
    me.name = name
    me.x = x
    me.y = y
    me.score = score
} );

setTimeout(() => {
    console.log(me);
    socket.disconnect();
}, 1000);

var newpos = socket.emitMove('up');

console.log(newpos)

var pos = await newpos;
console.log(pos);
/*
commento
*/



