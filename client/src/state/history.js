// Undo/redo stacks. Each command is { label, undo(), redo() } where undo and redo
// call the server, so undoing is itself a normal (and logged) change that other
// users see live. Only the current user's own actions are recorded.
export class History {
  constructor(limit = 50) {
    this.limit = limit;
    this.undoStack = [];
    this.redoStack = [];
  }

  // A new action invalidates anything that could have been redone.
  record(command) {
    this.undoStack.push(command);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
  }

  takeUndo() {
    return this.undoStack.pop();
  }

  takeRedo() {
    return this.redoStack.pop();
  }

  pushUndo(command) {
    this.undoStack.push(command);
  }

  pushRedo(command) {
    this.redoStack.push(command);
  }

  clear() {
    this.undoStack = [];
    this.redoStack = [];
  }

  get canUndo() {
    return this.undoStack.length > 0;
  }

  get canRedo() {
    return this.redoStack.length > 0;
  }

  get nextUndoLabel() {
    return this.undoStack.at(-1)?.label;
  }

  get nextRedoLabel() {
    return this.redoStack.at(-1)?.label;
  }
}
