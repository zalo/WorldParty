/* eslint-env browser */

// @ts-check
// Optional JS type checking, powered by TypeScript.
/** @typedef {import("partykit/server").Room} Room */
/** @typedef {import("partykit/server").Server} Server */
/** @typedef {import("partykit/server").Connection} Connection */
/** @typedef {import("partykit/server").ConnectionContext} ConnectionContext */

/** @implements {Server} */
class PartyServer {
  /** @param {Room} room */
  constructor(room) {
    this.playerColors = ["#FF0000", "#0000FF", "#FFFF00", "#FF00FF", "#00FFFF", "#FF8000", "#FF0080", "#8000FF", "#0080FF", "#80FF00", "#00FF80", "#FF8080", "#8080FF", "#FF80FF", "#80FFFF", "#FFFF80", "#FF80FF"];

    /** @type {Room} */
    this.room = room;

    /** @type {Record<string, { name: string, id:string, position: { x: number, y: number, z: number }, color:string | null}>} */
    this.players = {};
    /** @type {Record<number, { index:number, data: string }>} */
    this.chunks = {};
    this.globalPlayerCount = 0;

    /** @type {Record<string, boolean>} */
    this.needsUpdate = {};

    // Send an update message to all the connections
    this.updateCounter = 0;
    this.hasNewInfoToSend = false;
    this.interval = setInterval(() => {
      if(!this.hasNewInfoToSend) return;

      if(this.updateCounter % 300 === 0){
        // Send full update: Inefficient, but simple and robust
        this.room.broadcast(JSON.stringify({
          type: "fullupdate",
          players: this.players,
          chunks: this.chunks
        }));
      } else {
        // Accumulate partial updates from the objects that need updating
        /** @type {{type:string, players:Record<string, { name: string, id:string, position: { x: number, y: number, z: number }, color:string | null}>, chunks:Record<number, { index:number, data: string }>}}} */
        let partialUpdate = { type: "partialupdate", players: {}, chunks: {} };
        for(let player in this.players){
          if(this.needsUpdate[player]){
            partialUpdate.players[player] = this.players[player];
            this.needsUpdate[player] = false;
          }
        }
        for(let chunkIndex in this.chunks){
          if(this.needsUpdate[""+chunkIndex]){
            partialUpdate.chunks[chunkIndex] = this.chunks[chunkIndex];
            this.needsUpdate[""+chunkIndex] = false;
          }
        }

        // Send the partial update
        this.room.broadcast(JSON.stringify(partialUpdate));
      }
      this.updateCounter += 1;

      this.hasNewInfoToSend = false;
    }, 1000/30);
  }

  /**
   * @param {Connection} conn - The connection object.
   * @param {ConnectionContext} ctx - The context object. */
  onConnect(conn, ctx) {
    console.log(
      `Connected:
       id: ${conn.id}
       room: ${this.room.id}
       url: ${new URL(ctx.request.url).pathname}`
    );

    // Add the player to the list of players
    this.globalPlayerCount += 1;
    this.players[conn.id] = {
      name: "noob " + this.globalPlayerCount,
      color: this.playerColors[this.globalPlayerCount % this.playerColors.length],
      id: conn.id,
      position: { x: 0, y: 0, z: 0 }
    };
    this.needsUpdate[conn.id] = true;

    // Send an update message to all the connections
    this.room.broadcast(JSON.stringify({
      type: "fullupdate",
      players: this.players,
      chunks: this.chunks
    }));
  }

  /**
   * @param {string} message
   * @param {Connection} sender */
  onMessage(message, sender) {
    //console.log(`connection ${sender.id} sent message: ${message}`);

    if(message.startsWith("{")){
      let data = JSON.parse(message);
      if(data.type === "player"){
        this.players[sender.id].position.x = data.position.x;
        this.players[sender.id].position.y = data.position.y;
        this.players[sender.id].position.z = data.position.z;
        this.needsUpdate[sender.id] = true;
      }else if(data.type === "chunk"){
        if(!this.chunks[data.index]){
          this.chunks[data.index] = { index: data.index, data: data.data };
        }else{
            this.chunks[data.index].data = data.data;
        }
        this.needsUpdate[""+data.index] = true;
      } else if(data.type === "name"){
        this.players[sender.id].name = data.name;
        this.needsUpdate[sender.id] = true;
      }else if(data.type === "chat"){
        this.room.broadcast(JSON.stringify({
          type: "chat",
          sender: sender.id,
          message: data.message,
        }));
      } else if(data.type === "reset"){

      } else {
        console.error("Unknown message type: " + message);
      }
    }

    //// Broadcast the received message to all other connections in the room except the sender
    //this.room.broadcast(`${sender.id}: ${message}`, [sender.id]);

    // Send an update message to all the connections
    // TODO: Only send this at 15hz or so many active players don't exponentially increase outgoing bandwidth
    //this.room.broadcast(JSON.stringify({
    //  type: "fullupdate",
    //  players: this.players,
    //  cards: this.cards,
    //}));
    this.hasNewInfoToSend = true;
  }

  /** @param {Connection} conn - The connection object. */
  onDisconnect(conn){

    // Remove the player from the list of players
    delete this.players[conn.id];
    delete this.needsUpdate[conn.id];

    // Send an update message to all the connections
    this.room.broadcast(JSON.stringify({
      type: "fullupdate",
      players: this.players,
      chunks: this.chunks
    }));
  }

  /** @param {Connection} conn - The connection object. */
  onClose(conn){ this.onDisconnect(conn); }
  /**
   * @param {Connection} conn - The connection object.
   * @param {Error} error - The error object. */
  onError(conn, error){ console.error(error); this.onDisconnect(conn); }
}

export default PartyServer;