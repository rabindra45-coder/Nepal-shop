import { useMemo, useState, type FormEvent } from "react";
import { SafeAreaTopScrim } from "@hatch/space-sdk/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type ApiResponse } from "./api";
import heroArt from "./assets/media-generation-parcel-exchange-hero-0-364bfe57-0c17-45e8-89e7-830437bcf626.png";

type Product = ApiResponse<typeof api, "getStorefront">["products"][number];
type Order = ApiResponse<typeof api, "listOrders">["orders"][number];
type Tab = "shop" | "track" | "studio";
type Cart = Record<number, number>;

const money = (paisa: number) => `Rs ${(paisa / 100).toLocaleString("en-NP", { maximumFractionDigits: 2 })}`;
const date = (value: string) => new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
const statusLabel: Record<Order["status"], string> = { confirmation_needed: "Needs confirmation", confirmed: "Confirmed", packed: "Packed", shipped: "On the way", delivered: "Delivered", cancelled: "Cancelled" };
const nextStatus: Partial<Record<Order["status"], Order["status"]>> = { confirmation_needed: "confirmed", confirmed: "packed", packed: "shipped", shipped: "delivered" };

export function App() {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<Tab>("shop");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("All");
  const [cart, setCart] = useState<Cart>({});
  const [selected, setSelected] = useState<Product | null>(null);
  const [showCart, setShowCart] = useState(false);
  const [cartNotice, setCartNotice] = useState("");
  const storefront = useQuery({ queryKey: ["storefront"], queryFn: () => api.getStorefront({}) });

  const products = storefront.data?.products ?? [];
  const categories = ["All", ...new Set(products.map((p) => p.category))];
  const visible = products.filter((p) => (category === "All" || p.category === category) && `${p.name} ${p.description} ${p.category}`.toLowerCase().includes(query.toLowerCase()));
  const cartLines = useMemo(() => products.map((p) => ({ product: p, quantity: cart[p.id] ?? 0 })).filter((line) => line.quantity > 0), [products, cart]);
  const cartCount = cartLines.reduce((sum, line) => sum + line.quantity, 0);
  const cartSubtotal = cartLines.reduce((sum, line) => sum + line.product.price_paisa * line.quantity, 0);
  const cartDelivery = cartLines.reduce((sum, line) => sum + line.product.delivery_fee_paisa * line.quantity, 0);
  const invalidate = () => { void queryClient.invalidateQueries({ queryKey: ["storefront"] }); void queryClient.invalidateQueries({ queryKey: ["orders"] }); void queryClient.invalidateQueries({ queryKey: ["issues"] }); };
  const adjust = (id: number, by: number, stock: number) => {
    const incoming = products.find((p) => p.id === id);
    const currentSeller = cartLines[0]?.product.store_id;
    if (by > 0 && incoming && currentSeller && incoming.store_id !== currentSeller) {
      setCartNotice("One seller per order keeps delivery fees and confirmation clear. Finish or empty this basket first.");
      return;
    }
    setCartNotice("");
    setCart((current) => ({ ...current, [id]: Math.max(0, Math.min(stock, (current[id] ?? 0) + by)) }));
  };

  if (storefront.isPending) return <main className="loading">Opening the market…</main>;
  if (storefront.error) return <main className="loading">The storefront couldn’t load. Please reopen it.</main>;

  return (
    <div className="app-shell">
      <SafeAreaTopScrim backgroundColor="var(--bg)" />
      <header className="topbar">
        <nav aria-label="Main sections" className="tabs">
          <button className={tab === "shop" ? "active" : ""} onClick={() => setTab("shop")}>Shop</button>
          <button className={tab === "track" ? "active" : ""} onClick={() => setTab("track")}>My order</button>
          <button className={tab === "studio" ? "active" : ""} onClick={() => setTab("studio")}>Seller studio</button>
        </nav>
        {tab === "shop" && <button className="cart-button" onClick={() => setShowCart(true)} aria-label={`Open basket with ${cartCount} items`}>Basket <span>{cartCount}</span></button>}
      </header>

      {tab === "shop" && <main>
        <section className="hero">
          <div className="hero-copy">
            <p className="eyebrow">Local marketplace</p>
            <h1>Shop local.<br/>Know who packed it.</h1>
            <p>{storefront.data?.seller_count ? `${storefront.data.seller_count} local ${storefront.data.seller_count === 1 ? "seller" : "sellers"}, one transparent checkout.` : "Products appear here when the first local seller publishes a listing."}</p>
          </div>
          <img src={heroArt} alt="Two hands passing a wrapped parcel across a shop counter" />
        </section>

        <section className="trust-strip" aria-label="Shopping protections">
          <div><b>01</b><span>Total shown before ordering</span></div>
          <div><b>02</b><span>COD waits for seller confirmation</span></div>
          <div><b>03</b><span>Reviews require delivery</span></div>
        </section>

        {cartNotice && <p className="cart-notice" role="status">{cartNotice}</p>}
        <section className="catalog">
          <div className="catalog-head">
            <div><p className="eyebrow">Open shelves</p><h2>What’s in stock</h2></div>
            <label className="search"><span>Search</span><input aria-label="Search products" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Name, category, detail" /></label>
          </div>
          {categories.length > 1 && <div className="category-list" aria-label="Product categories">{categories.map((item) => <button key={item} className={category === item ? "selected" : ""} onClick={() => setCategory(item)}>{item}</button>)}</div>}
          {visible.length === 0 ? <div className="empty-state"><span>THE SHELVES ARE QUIET</span><h3>{products.length ? "No products match that search." : "This seller hasn’t published a product yet."}</h3><p>{products.length ? "Try another word or show every category." : "Open Seller studio to create the store profile and first real listing."}</p>{products.length === 0 && <button className="primary" onClick={() => setTab("studio")}>Set up the store</button>}</div> : <div className="product-grid">{visible.map((product, index) => <article className="product" key={product.id}>
            <button className="product-open" onClick={() => setSelected(product)} aria-label={`View ${product.name}`}>
              <div className={`product-mark mark-${index % 4}`} aria-hidden="true"><span>{product.category.slice(0, 2).toUpperCase()}</span></div>
              <div className="product-body"><p>{product.category}</p><h3>{product.name}</h3><small className="seller-line">Seller-provided profile · {product.store_name} · {product.store_location}</small><span className="desc">{product.description}</span><div className="price-line"><strong>{money(product.price_paisa)}</strong><small>{product.stock} in stock</small></div>{product.rating !== null && <small className="rating">★ {product.rating.toFixed(1)} · {product.review_count} verified</small>}</div>
            </button>
            <button className="add" disabled={product.stock === 0} onClick={() => adjust(product.id, 1, product.stock)}>{product.stock ? ((cart[product.id] ?? 0) ? `Add another · ${cart[product.id]} in basket` : "Add to basket") : "Out of stock"}</button>
          </article>)}</div>}
        </section>
      </main>}

      {tab === "track" && <TrackOrder invalidate={invalidate} />}
      {tab === "studio" && <Studio invalidate={invalidate} />}

      {selected && <ProductSheet product={selected} quantity={cart[selected.id] ?? 0} close={() => setSelected(null)} adjust={(by) => adjust(selected.id, by, selected.stock)} />}
      {showCart && <CheckoutSheet lines={cartLines} subtotal={cartSubtotal} delivery={cartDelivery} close={() => setShowCart(false)} adjust={adjust} onPlaced={(code) => { setCart({}); setShowCart(false); setTab("track"); sessionStorage.setItem("lastOrderCode", code); invalidate(); }} />}
    </div>
  );
}

function ProductSheet({ product, quantity, close, adjust }: { product: Product; quantity: number; close: () => void; adjust: (by: number) => void }) {
  const reviews = useQuery({ queryKey: ["reviews", product.id], queryFn: () => api.getProductReviews({ product_id: product.id }) });
  return <div className="overlay" role="dialog" aria-modal="true" aria-label={`${product.name} details`}><div className="sheet"><button className="sheet-close" onClick={close} aria-label="Close product details">Close</button><div className="sheet-mark"><span>{product.category}</span></div><p className="eyebrow">{product.category}</p><h2>{product.name}</h2><p className="seller-line">Seller-provided profile · {product.store_name} · {product.store_location}</p><p>{product.description}</p><div className="detail-price"><strong>{money(product.price_paisa)}</strong><span>+ {money(product.delivery_fee_paisa)} delivery each</span></div><div className="quantity"><button onClick={() => adjust(-1)} disabled={quantity === 0} aria-label={`Remove one ${product.name}`}>−</button><span>{quantity}</span><button onClick={() => adjust(1)} disabled={quantity >= product.stock} aria-label={`Add one ${product.name}`}>+</button></div><section className="reviews"><h3>Verified buyers</h3>{reviews.data?.reviews.length ? reviews.data.reviews.map((review) => <article key={review.id}><b>{"★".repeat(review.rating)}</b><p>{review.body}</p><small>{review.reviewer_name} · {date(review.created_at)}</small></article>) : <p className="muted">No delivered-buyer reviews yet.</p>}</section></div></div>;
}

function CheckoutSheet({ lines, subtotal, delivery, close, adjust, onPlaced }: { lines: { product: Product; quantity: number }[]; subtotal: number; delivery: number; close: () => void; adjust: (id: number, by: number, stock: number) => void; onPlaced: (code: string) => void }) {
  const [error, setError] = useState("");
  const order = useMutation({ mutationFn: api.placeOrder, onSuccess: (result) => onPlaced(result.order_code), onError: (e) => setError(String(e instanceof Error ? e.message : e)) });
  const submit = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); setError(""); const data = new FormData(event.currentTarget); order.mutate({ customer_name: String(data.get("name") ?? ""), phone: String(data.get("phone") ?? ""), address: String(data.get("address") ?? ""), note: String(data.get("note") ?? ""), cod_confirmed: true, items: lines.map((l) => ({ product_id: l.product.id, quantity: l.quantity })) }); };
  return <div className="overlay" role="dialog" aria-modal="true" aria-label="Basket and checkout"><div className="sheet checkout"><button className="sheet-close" onClick={close} aria-label="Close basket">Close</button><p className="eyebrow">Your parcel</p><h2>Check every rupee</h2>{lines.length === 0 ? <div className="empty-mini"><p>Your basket is empty.</p><button onClick={close}>Keep shopping</button></div> : <><div className="cart-lines">{lines.map(({ product, quantity }) => <div className="cart-line" key={product.id}><div><b>{product.name}</b><small>{money(product.price_paisa)} each</small></div><div className="quantity small"><button onClick={() => adjust(product.id, -1, product.stock)} aria-label={`Remove one ${product.name}`}>−</button><span>{quantity}</span><button onClick={() => adjust(product.id, 1, product.stock)} aria-label={`Add one ${product.name}`}>+</button></div></div>)}</div><div className="receipt"><span>Items <b>{money(subtotal)}</b></span><span>Delivery <b>{money(delivery)}</b></span><span className="total">Due on delivery <b>{money(subtotal + delivery)}</b></span></div><form onSubmit={submit} className="stack-form"><label>Your name<input name="name" required minLength={2}/></label><label>Mobile number<input name="phone" type="tel" required minLength={7}/></label><label>Delivery address<textarea name="address" required minLength={5}/></label><label>Note for seller <textarea name="note" /></label><div className="payment-choice"><b>Cash on delivery</b><p>No money is taken now. Your order stays “Needs confirmation” until the seller accepts it.</p></div><label className="check"><input type="checkbox" required/> I’ll respond when the seller confirms this COD order.</label>{error && <p className="form-error">{error}</p>}<button className="primary" disabled={order.isPending}>{order.isPending ? "Placing order…" : `Place COD order · ${money(subtotal + delivery)}`}</button></form><details className="wallet-note"><summary>Why aren’t eSewa and Khalti active?</summary><p>Wallet checkout needs approved merchant credentials. Merchant terms, including reported 1.5–2% fees and T+1 settlement, should be reconfirmed at signup.</p><a href="https://fossatechnology.com.np/blog/esewa-khalti-integration-nepal" target="_blank" rel="noreferrer">Read the integration guide</a></details></>}</div></div>;
}

function TrackOrder({ invalidate }: { invalidate: () => void }) {
  const [credentials, setCredentials] = useState({ order_code: sessionStorage.getItem("lastOrderCode") ?? "", phone: "" });
  const [enabled, setEnabled] = useState(false);
  const track = useQuery({ queryKey: ["track", credentials], queryFn: () => api.trackOrder(credentials), enabled });
  const submit = (e: FormEvent<HTMLFormElement>) => { e.preventDefault(); setEnabled(false); const data = new FormData(e.currentTarget); setCredentials({ order_code: String(data.get("code") ?? "").toUpperCase(), phone: String(data.get("phone") ?? "") }); setTimeout(() => setEnabled(true), 0); };
  return <main className="track-page"><section className="track-intro"><p className="eyebrow">No account needed</p><h1>Follow your parcel.</h1><p>Your order code and phone number reveal only your matching order.</p></section><form className="track-form" onSubmit={submit}><label>Order code<input name="code" defaultValue={credentials.order_code} placeholder="NP-…" required /></label><label>Mobile number<input name="phone" type="tel" required /></label><button className="primary">Find order</button></form>{track.isFetching && <p className="muted">Checking the order trail…</p>}{enabled && track.data?.order === null && <div className="empty-state"><h3>No matching order</h3><p>Check the code and mobile number exactly as entered at checkout.</p></div>}{track.data?.order && <OrderTrail order={track.data.order} credentials={credentials} invalidate={() => { invalidate(); void track.refetch(); }} />}</main>;
}

function OrderTrail({ order, credentials, invalidate }: { order: Order; credentials: { order_code: string; phone: string }; invalidate: () => void }) {
  const [message, setMessage] = useState("");
  const issue = useMutation({ mutationFn: api.reportIssue, onSuccess: () => { setMessage("Your issue is now in the seller’s queue."); invalidate(); } });
  const review = useMutation({ mutationFn: api.addReview, onSuccess: () => { setMessage("Your verified review is published."); invalidate(); } });
  const steps: Order["status"][] = ["confirmation_needed", "confirmed", "packed", "shipped", "delivered"];
  const current = steps.indexOf(order.status);
  return <section className="order-trail"><div className="order-heading"><div><p className="eyebrow">{order.order_code}</p><h2>{statusLabel[order.status]}</h2></div><strong>{money(order.total_paisa)}</strong></div><div className="timeline">{steps.map((step, index) => <div className={index <= current && order.status !== "cancelled" ? "done" : ""} key={step}><span>{index + 1}</span><b>{statusLabel[step]}</b></div>)}</div><div className="order-items">{order.items.map((item) => <span key={item.id}>{item.quantity} × {item.product_name}<b>{money(item.quantity * item.unit_price_paisa)}</b></span>)}<span>Delivery<b>{money(order.delivery_fee_paisa)}</b></span></div><p className="muted">Ordered {date(order.created_at)} · {order.status === "cancelled" ? "No payment due" : order.status === "delivered" ? "Payment method: Cash on delivery" : "Cash due on delivery"}</p>{order.status === "delivered" && <details><summary>Write a verified review</summary><form className="stack-form compact" onSubmit={(e) => { e.preventDefault(); const d = new FormData(e.currentTarget); review.mutate({ ...credentials, product_id: Number(d.get("product")), rating: Number(d.get("rating")), body: String(d.get("body") ?? "") }); }}><label>Product<select name="product">{order.items.map((item) => <option value={item.product_id} key={item.id}>{item.product_name}</option>)}</select></label><label>Rating<select name="rating"><option value="5">5 — Excellent</option><option value="4">4 — Good</option><option value="3">3 — Okay</option><option value="2">2 — Poor</option><option value="1">1 — Bad</option></select></label><label>Review<textarea name="body" minLength={3} required /></label><button>Publish verified review</button></form></details>}<details><summary>Report a problem</summary><form className="stack-form compact" onSubmit={(e) => { e.preventDefault(); const d = new FormData(e.currentTarget); issue.mutate({ ...credentials, kind: String(d.get("kind") ?? ""), detail: String(d.get("detail") ?? "") }); }}><label>Issue<select name="kind"><option>Delivery delay</option><option>Wrong item</option><option>Damaged item</option><option>Refund request</option><option>Other</option></select></label><label>What happened?<textarea name="detail" minLength={8} required /></label><button>Send to seller</button></form></details>{message && <p className="success">{message}</p>}</section>;
}

function Studio({ invalidate }: { invalidate: () => void }) {
  const queryClient=useQueryClient();
  const [sellerCode,setSellerCode]=useState(""); const [sellerKey,setSellerKey]=useState("");
  const [draftCode,setDraftCode]=useState(""); const [draftKey,setDraftKey]=useState("");
  const [showRegister,setShowRegister]=useState(false); const [editing,setEditing]=useState<Product|null>(null); const [notice,setNotice]=useState("");
  const inventory=useQuery({queryKey:["seller-inventory",sellerCode,sellerKey],queryFn:()=>api.sellerInventory({seller_code:sellerCode,seller_key:sellerKey}),enabled:sellerCode.length>=6&&sellerKey.length>=8,retry:false});
  const orders=useQuery({queryKey:["orders",sellerCode],queryFn:()=>api.listOrders({seller_code:sellerCode,seller_key:sellerKey,limit:100}),enabled:inventory.isSuccess,retry:false});
  const issues=useQuery({queryKey:["issues",sellerCode],queryFn:()=>api.listIssues({seller_code:sellerCode,seller_key:sellerKey}),enabled:inventory.isSuccess,retry:false});
  const privateRefresh=()=>{invalidate();void queryClient.invalidateQueries({queryKey:["seller-inventory"]});void queryClient.invalidateQueries({queryKey:["orders"]});void queryClient.invalidateQueries({queryKey:["issues"]});};
  const register=useMutation({mutationFn:api.registerSeller,onSuccess:(result,vars)=>{setSellerCode(result.seller_code);setSellerKey(vars.seller_key);setNotice(`Seller account created. Save this code: ${result.seller_code}`);privateRefresh();}});
  const saveStore=useMutation({mutationFn:api.saveStore,onSuccess:()=>{setNotice("Store details saved.");privateRefresh();}});
  const create=useMutation({mutationFn:api.createProduct,onSuccess:()=>{setNotice("Product published.");privateRefresh();}});
  const update=useMutation({mutationFn:api.updateProduct,onSuccess:()=>{setNotice("Product updated.");setEditing(null);privateRefresh();}});
  const updateOrder=useMutation({mutationFn:api.updateOrderStatus,onSuccess:privateRefresh}); const resolve=useMutation({mutationFn:api.resolveIssue,onSuccess:privateRefresh});
  const products=inventory.data?.products??[]; const orderRows=orders.data?.orders??[]; const issueRows=issues.data?.issues??[]; const store=inventory.data?.store??null;
  const saveProduct=(e:FormEvent<HTMLFormElement>)=>{e.preventDefault();const d=new FormData(e.currentTarget);const payload={seller_code:sellerCode,seller_key:sellerKey,name:String(d.get("name")??""),category:String(d.get("category")??""),description:String(d.get("description")??""),price_paisa:Math.round(Number(d.get("price"))*100),delivery_fee_paisa:Math.round(Number(d.get("delivery"))*100),stock:Number(d.get("stock"))};if(editing)update.mutate({...payload,id:editing.id,is_active:d.get("active")==="on"});else create.mutate(payload);};
  if(!sellerCode||inventory.error)return <main className="studio-page"><section className="studio-intro"><p className="eyebrow">Private seller workspace</p><h1>Enter your shop.</h1><p>Each seller has a separate code and key, so one shop can never open another shop’s customer orders or drafts.</p></section>{!showRegister?<form className="track-form seller-unlock" onSubmit={(e)=>{e.preventDefault();setSellerCode(draftCode.toUpperCase());setSellerKey(draftKey);}}><label>Seller code<input value={draftCode} onChange={(e)=>setDraftCode(e.target.value)} placeholder="SELL-…" required/></label><label>Private access key<input type="password" minLength={8} value={draftKey} onChange={(e)=>setDraftKey(e.target.value)} required/></label><button className="primary">Unlock studio</button></form>:<form className="stack-form claim-form" onSubmit={(e)=>{e.preventDefault();const d=new FormData(e.currentTarget);register.mutate({store_name:String(d.get("store")??""),tagline:String(d.get("tagline")??""),location:String(d.get("location")??""),phone:String(d.get("phone")??""),seller_key:String(d.get("key")??"")});}}><label>Store name<input name="store" required/></label><label>Short promise<input name="tagline" required/></label><label>Location<input name="location" required/></label><label>Public contact<input name="phone" required/></label><label>Private access key<input name="key" type="password" minLength={8} required/><small>At least 8 characters. Save it securely; it is not shown in the marketplace.</small></label>{register.error&&<p className="form-error">{String(register.error instanceof Error?register.error.message:register.error)}</p>}<button className="primary" disabled={register.isPending}>{register.isPending?"Creating…":"Create seller account"}</button></form>}<button className="switch-mode" onClick={()=>setShowRegister((v)=>!v)}>{showRegister?"I already have a seller code":"Create a new seller account"}</button>{inventory.error&&<p className="form-error">That seller code and key didn’t match.</p>}</main>;
  if(inventory.isPending||orders.isPending||issues.isPending)return <main className="studio-page"><p className="muted">Unlocking the studio…</p></main>;
  return <main className="studio-page"><section className="studio-intro"><p className="eyebrow">{sellerCode}</p><h1>Run the counter.</h1><p>Publish real inventory, confirm COD orders, and resolve buyer issues from one protected place.</p><button className="switch-mode" onClick={()=>{setSellerCode("");setSellerKey("");}}>Lock studio</button></section>{notice&&<p className="success banner">{notice}</p>}<div className="studio-layout"><section className="studio-section"><h2>Store identity</h2><form className="stack-form" onSubmit={(e)=>{e.preventDefault();const d=new FormData(e.currentTarget);saveStore.mutate({seller_code:sellerCode,seller_key:sellerKey,store_name:String(d.get("store")??""),tagline:String(d.get("tagline")??""),location:String(d.get("location")??""),phone:String(d.get("phone")??"")});}}><label>Store name<input name="store" defaultValue={store?.store_name} required/></label><label>Short promise<input name="tagline" defaultValue={store?.tagline} required/></label><label>Location<input name="location" defaultValue={store?.location} required/></label><label>Public contact<input name="phone" defaultValue={store?.phone} required/></label><button className="primary">Save store</button></form></section>
<section className="studio-section"><div className="section-title"><h2>{editing?"Edit product":"New product"}</h2>{editing&&<button onClick={()=>setEditing(null)}>Cancel edit</button>}</div><form className="stack-form" key={editing?.id??"new"} onSubmit={saveProduct}><label>Product name<input name="name" defaultValue={editing?.name} required/></label><div className="form-pair"><label>Category<input name="category" defaultValue={editing?.category} required/></label><label>Stock<input name="stock" type="number" min="0" defaultValue={editing?.stock??1} required/></label></div><label>Description<textarea name="description" defaultValue={editing?.description} minLength={8} required/></label><div className="form-pair"><label>Price, rupees<input name="price" type="number" min="0.01" step="0.01" defaultValue={editing?editing.price_paisa/100:""} required/></label><label>Delivery, rupees<input name="delivery" type="number" min="0" step="0.01" defaultValue={editing?editing.delivery_fee_paisa/100:0} required/></label></div>{editing&&<label className="check"><input name="active" type="checkbox" defaultChecked={editing.is_active}/> Visible in shop</label>}<button className="primary" disabled={create.isPending||update.isPending}>{editing?"Save product":"Publish product"}</button></form><div className="product-admin">{products.map((p)=><button key={p.id} onClick={()=>setEditing(p)}><span><b>{p.name}</b><small>{p.is_active?`${p.stock} in stock`:"Hidden"}</small></span><strong>{money(p.price_paisa)}</strong></button>)}</div></section>
<section className="studio-section wide"><div className="section-title"><h2>Orders</h2><span>{orderRows.length}</span></div>{orderRows.length===0?<p className="muted">New COD orders for this shop will arrive here.</p>:<div className="order-admin">{orderRows.map((order)=><article key={order.id}><div><p className="eyebrow">{order.order_code} · {date(order.created_at)}</p><h3>{order.customer_name}</h3><p>{order.items.map((i)=>`${i.quantity} × ${i.product_name}`).join(", ")}</p><small>{order.address} · {order.phone}</small></div><div className="order-actions"><b>{money(order.total_paisa)}</b><span className={`status ${order.status}`}>{statusLabel[order.status]}</span>{nextStatus[order.status]&&<button onClick={()=>updateOrder.mutate({seller_code:sellerCode,seller_key:sellerKey,order_id:order.id,status:nextStatus[order.status]??order.status})}>Mark {statusLabel[nextStatus[order.status]??order.status].toLowerCase()}</button>}{order.status==="confirmation_needed"&&<button className="text-danger" onClick={()=>updateOrder.mutate({seller_code:sellerCode,seller_key:sellerKey,order_id:order.id,status:"cancelled"})}>Decline</button>}</div></article>)}</div>}</section>
<section className="studio-section wide"><div className="section-title"><h2>Buyer issues</h2><span>{issueRows.filter((i)=>i.status==="open").length} open</span></div>{issueRows.length===0?<p className="muted">No buyer issues reported for this shop.</p>:<div className="issues">{issueRows.map((item)=><article key={item.id}><div><p className="eyebrow">{item.order_code} · {item.kind}</p><p>{item.detail}</p><small>{date(item.created_at)}</small></div>{item.status==="open"?<button onClick={()=>resolve.mutate({seller_code:sellerCode,seller_key:sellerKey,issue_id:item.id})}>Mark resolved</button>:<span className="success">Resolved</span>}</article>)}</div>}</section>
<section className="evidence wide"><h2>Why these controls exist</h2><p>Nepal’s seller ecosystem is formalizing, while COD return-to-origin remains a costly risk. The sources below informed the confirmation trail; their figures are market context, not this shop’s performance.</p><div><a href="https://kathmandupost.com/money/2026/08/27/fast-delivery-changes-the-game-for-nepal-s-online-sellers" target="_blank" rel="noreferrer">E-commerce registration and seller context</a><a href="https://medium.com/@ncndeliveryseo/cash-on-delivery-cod-in-nepal-benefits-risks-and-best-practices-fc193c365b06" target="_blank" rel="noreferrer">COD and return-to-origin practices</a></div></section></div></main>;
}
