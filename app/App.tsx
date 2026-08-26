import { useState, useEffect, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

type Todo = {
  id: number;
  text: string;
  done: boolean;
};

type Filter = 'all' | 'active' | 'done';

function App() {
  const [todos, setTodos] = useState<Todo[]>(() => {
    try {
      const raw = localStorage.getItem('todos');
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  });
  const [input, setInput] = useState('');
  const [filter, setFilter] = useState<Filter>('all');

  useEffect(() => {
    localStorage.setItem('todos', JSON.stringify(todos));
  }, [todos]);

  const addTodo = () => {
    const text = input.trim();
    if (!text) return;
    setTodos((prev) => [...prev, { id: Date.now(), text, done: false }]);
    setInput('');
  };

  const toggleTodo = (id: number) => {
    setTodos((prev) => prev.map((t) => (t.id === id ? { ...t, done: !t.done } : t)));
  };

  const removeTodo = (id: number) => {
    setTodos((prev) => prev.filter((t) => t.id !== id));
  };

  const clearDone = () => {
    setTodos((prev) => prev.filter((t) => !t.done));
  };

  const filtered = useMemo(() => {
    if (filter === 'active') return todos.filter((t) => !t.done);
    if (filter === 'done') return todos.filter((t) => t.done);
    return todos;
  }, [todos, filter]);

  const remaining = todos.filter((t) => !t.done).length;

  return (
    <div className="container">
      <header>
        <h1>✅ 待办清单</h1>
        <p className="subtitle">
          {remaining === 0 ? '全部完成，太棒了！' : `还有 ${remaining} 件事要做`}
        </p>
      </header>

      <div className="add-row">
        <input
          className="input"
          value={input}
          placeholder="想做什么？按回车添加"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && addTodo()}
          maxLength={100}
        />
        <button className="btn add-btn" onClick={addTodo} disabled={!input.trim()}>
          ＋ 添加
        </button>
      </div>

      <div className="toolbar">
        <div className="filters">
          {(['all', 'active', 'done'] as Filter[]).map((f) => (
            <button
              key={f}
              className={`filter-btn ${filter === f ? 'active' : ''}`}
              onClick={() => setFilter(f)}
            >
              {f === 'all' ? '全部' : f === 'active' ? '进行中' : '已完成'}
              <span className="count">
                {f === 'all'
                  ? todos.length
                  : f === 'active'
                    ? todos.filter((t) => !t.done).length
                    : todos.filter((t) => t.done).length}
              </span>
            </button>
          ))}
        </div>
        {todos.some((t) => t.done) && (
          <button className="clear-btn" onClick={clearDone}>
            清除已完成
          </button>
        )}
      </div>

      <ul className="list">
        {filtered.length === 0 && (
          <li className="empty">
            {filter === 'all' ? '暂无任务，添加一个吧 ✍️' : filter === 'active' ? '没有进行中的任务' : '还没有完成的任务'}
          </li>
        )}
        {filtered.map((todo) => (
          <li key={todo.id} className={`todo ${todo.done ? 'done' : ''}`}>
            <label className="check">
              <input
                type="checkbox"
                checked={todo.done}
                onChange={() => toggleTodo(todo.id)}
              />
              <span className="box" aria-hidden="true" />
            </label>
            <span className="text">{todo.text}</span>
            <button
              className="del-btn"
              onClick={() => removeTodo(todo.id)}
              title="删除"
            >
              ✕
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
