import { buildModule } from "@nomicfoundation/ignition-core";

const effectstreaml2Module = buildModule("effectstreaml2Module", (m) => {
  const owner = m.getParameter("owner");
  const fee = m.getParameter("fee");
  const contract = m.contract("effectstreaml2", [owner, fee]);
  return { contract };
});

export default effectstreaml2Module;
